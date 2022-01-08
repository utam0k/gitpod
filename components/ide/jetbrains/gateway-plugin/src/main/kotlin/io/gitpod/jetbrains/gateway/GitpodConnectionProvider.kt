// Copyright (c) 2021 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package io.gitpod.jetbrains.gateway

import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.remote.RemoteCredentialsHolder
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.gridLayout.HorizontalAlign
import com.intellij.ui.dsl.gridLayout.VerticalAlign
import com.jetbrains.gateway.api.ConnectionRequestor
import com.jetbrains.gateway.api.GatewayConnectionHandle
import com.jetbrains.gateway.api.GatewayConnectionProvider
import com.jetbrains.gateway.ssh.ClientOverSshTunnelConnector
import com.jetbrains.gateway.thinClientLink.ThinClientHandle
import com.jetbrains.rd.util.URI
import com.jetbrains.rd.util.lifetime.Lifetime
import io.gitpod.gitpodprotocol.api.entities.WorkspaceInstance
import io.gitpod.gitpodprotocol.api.entities.WorkspacePhase
import io.gitpod.jetbrains.icons.GitpodIcons
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.future.await
import kotlinx.coroutines.launch
import java.net.URL
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import javax.swing.JComponent
import javax.swing.JLabel

class GitpodConnectionProvider : GatewayConnectionProvider {

    private val gitpod = service<GitpodConnectionService>()

    override suspend fun connect(
        parameters: Map<String, String>,
        requestor: ConnectionRequestor
    ): GatewayConnectionHandle? {
        if (parameters["gitpodHost"] == null) {
            throw IllegalArgumentException("bad gitpodHost parameter");
        }
        if (parameters["workspaceId"] == null) {
            throw IllegalArgumentException("bad workspaceId parameter");
        }
        val connectParams = ConnectParams(
            parameters["gitpodHost"]!!,
            parameters["workspaceId"]!!
        )
        val client = gitpod.obtainClient(connectParams.gitpodHost)
        val connectionLifetime = Lifetime.Eternal.createNested()
        val updates = client.listenToWorkspace(connectionLifetime, connectParams.workspaceId)
        val workspace = client.syncWorkspace(connectParams.workspaceId)

        val phaseMessage = JLabel()
        val statusMessage = JLabel()
        val errorMessage = JLabel()
        val connectionPanel = panel {
            row {
                resizableRow()
                panel {
                    verticalAlign(VerticalAlign.CENTER)
                    row {
                        icon(GitpodIcons.Logo)
                            .horizontalAlign(HorizontalAlign.CENTER)
                    }
                    row {
                        cell(phaseMessage)
                            .bold()
                            .horizontalAlign(HorizontalAlign.CENTER)
                    }
                    row {
                        cell(statusMessage)
                            .horizontalAlign(HorizontalAlign.CENTER)
                    }
                    panel {
                        row {
                            label(connectParams.workspaceId)

                        }
                        row {
                            browserLink(workspace.contextURL, workspace.contextURL)
                        }
                    }.horizontalAlign(HorizontalAlign.CENTER)
                    row {
                        cell(errorMessage)
                    }
                }
            }
        }

        GlobalScope.launch {
            var thinClient: ThinClientHandle? = null;

            val httpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS)
                .connectTimeout(Duration.ofSeconds(2))
                .build()

            var lastUpdate: WorkspaceInstance? = null;
            try {
                for (update in updates) {
                    try {
                        if (lastUpdate != null &&
                            lastUpdate.id == update.id &&
                            WorkspacePhase.valueOf(lastUpdate.status.phase).ordinal >= WorkspacePhase.valueOf(update.status.phase).ordinal
                        ) {
                            // we already up to date
                            continue;
                        }
                        if (!update.status.conditions.failed.isNullOrBlank()) {
                            errorMessage.text = update.status.conditions.failed;
                        }
                        when (update.status.phase) {
                            "preparing" -> {
                                phaseMessage.text = "Preparing"
                                statusMessage.text = "Building workspace image..."
                            }
                            "pending" -> {
                                phaseMessage.text = "Preparing"
                                statusMessage.text = "Allocating resources …"
                            }
                            "creating" -> {
                                phaseMessage.text = "Creating"
                                statusMessage.text = "Pulling workspace image …"
                            }
                            "initializing" -> {
                                phaseMessage.text = "Starting"
                                statusMessage.text = "Initializing workspace content …"
                            }
                            "running" -> {
                                // TODO(ak) fetch supervisor for desktop ide ready then Starting
                                phaseMessage.text = "Ready"
                                statusMessage.text = ""
                            }
                            "interrupted" -> {
                                phaseMessage.text = "Starting"
                                statusMessage.text = "Checking workspace …"
                            }
                            "stopping" -> {
                                phaseMessage.text = "Stopping"
                                statusMessage.text = ""
                            }
                            "stopped" -> {
                                if (update.status.conditions.timeout.isNullOrBlank()) {
                                    phaseMessage.text = "Stopped"
                                } else {
                                    phaseMessage.text = "Timed Out"
                                }
                                statusMessage.text = ""
                            }
                            else -> {
                                phaseMessage.text = ""
                                statusMessage.text = ""
                            }
                        }

                        if (update.status.phase == "stopping" || update.status.phase == "stopped") {
                            thinClient?.close()
                        }

                        if (thinClient == null && update.status.phase == "running") {
                            val ownerToken = client.server.getOwnerToken(update.workspaceId).await()

                            val ideUrl = URL(update.ideUrl);
                            val httpRequest = HttpRequest.newBuilder()
                                .uri(URI.create("https://24000-${ideUrl.host}/joinLink"))
                                .header("x-gitpod-owner-token", ownerToken)
                                .GET()
                                .build()
                            val response = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

                            if (response.statusCode() != 200) {
                                errorMessage.text =
                                    "failed to check workspace connectivity status ${response.statusCode()}"
                                continue;
                            }
                            val joinLink = response.body()

                            val credentials = RemoteCredentialsHolder()
                            credentials.setHost(ideUrl.host)
                            credentials.port = 22
                            credentials.userName = update.workspaceId
                            credentials.password = ownerToken

                            val connector = ClientOverSshTunnelConnector(
                                connectionLifetime,
                                credentials,
                                URI(joinLink)
                            )
                            val client = connector.connect()
                            client.clientClosed.advise(connectionLifetime) {
                                connectionLifetime.terminate()
                            }
                            thinClient = client
                        }
                    } catch (e: Throwable) {
                        thisLogger().error(
                            "${connectParams.gitpodHost}: ${connectParams.workspaceId}: failed to process workspace update:",
                            e
                        )
                    }
                }
                connectionLifetime.terminate()
            } catch (t: Throwable) {
                thisLogger().error(
                    "${connectParams.gitpodHost}: ${connectParams.workspaceId}: failed to process workspace updates:",
                    t
                )
                errorMessage.text = " failed to process workspace updates ${t.message}"
            }
        }

        return GitpodConnectionHandle(connectionLifetime, connectionPanel, connectParams);
    }

    override fun isApplicable(parameters: Map<String, String>): Boolean =
        parameters.containsKey("gitpodHost")

    private data class ConnectParams(
        val gitpodHost: String,
        val workspaceId: String
    )

    private class GitpodConnectionHandle(
        lifetime: Lifetime,
        private val component: JComponent,
        private val params: ConnectParams
    ) : GatewayConnectionHandle(lifetime) {

        override fun createComponent(): JComponent {
            return component
        }

        override fun getTitle(): String {
            return "${params.workspaceId} (${params.gitpodHost})"
        }

        override fun hideToTrayOnStart(): Boolean {
            return false
        }
    }

}
