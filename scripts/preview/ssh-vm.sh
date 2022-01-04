#!/usr/bin/env bash
#
# Provides SSH access to the the VM where your preview environment is installed.
#

set -euo pipefail

# TODO
# - Start proxy, save PID, terminate on exit
# - Download and chmod ssh keys
# - (Verify VM exists?)
# - SSH and start interacitve session
# - optional: Make it possible to pass in a command so that it's a one-off way to SSH (use in Werft job)

HARVESTER_KUBECONFIG_PATH="$HOME/.kube/config-harvester"
PORT_FORWARD_PID=""

if [[ ! -f "$HARVESTER_KUBECONFIG_PATH" ]]; then
    echo "Missing Harvester kubeconfig at $HARVESTER_KUBECONFIG_PATH. Downloading config."
    kubectl -n werft get secret harvester-kubeconfig -o jsonpath='{.data}' \
    | jq -r '.["harvester-kubeconfig.yml"]' \
    | base64 -d \
    > "$HARVESTER_KUBECONFIG_PATH"
fi

function cleanup {
    echo "Executing cleanup"
    if [[ -n "$PORT_FORWARD_PID" ]]; then
        echo "Terminating port-forwarding with PID: $PORT_FORWARD_PID"
        kill -9 "$PORT_FORWARD_PID" > /dev/null 2>&1
    fi
}

function prepareSSHKeys {
    kubectl -n werft get secret harvester-vm-ssh-keys -o jsonpath='{.data}' | jq -r '.["id_rsa"]' | base64 -d > "$HOME/.ssh/id_rsa"
    kubectl -n werft get secret harvester-vm-ssh-keys -o jsonpath='{.data}' | jq -r '.["id_rsa.pub"]' | base64 -d > "$HOME/.ssh/id_rsa.pub"

    chmod 600 "$HOME/.ssh/id_rsa"
    chmod 644 "$HOME/.ssh/id_rsa.pub"
}

function startKubectlPortForwardForSSH {
    local vmName namespace
    vmName="$(git symbolic-ref HEAD 2>&1 | awk '{ sub(/^refs\/heads\//, ""); $0 = tolower($0); gsub(/[^-a-z0-9]/, "-"); print }')"
    namespace="preview-${vmName}"

    echo "Verifying VM exists"
    sudo kubectl \
        --kubeconfig="$HARVESTER_KUBECONFIG_PATH" \
        -n "$namespace" \
        get vmi "${vmName}" > /dev/null

    echo "Starting SSH port-forwaring to VM: ${vmName}"
    sudo kubectl \
        --kubeconfig="$HARVESTER_KUBECONFIG_PATH" \
        -n "$namespace" \
        port-forward service/proxy 22:22 &
    PORT_FORWARD_PID="$!"
}

trap "cleanup" EXIT

prepareSSHKeys
startKubectlPortForwardForSSH
ssh ubuntu@127.0.0.1


# # Workspace: Start SSH proxy
# sudo kubectl \
# 	--kubeconfig=harvester-kubeconfig.yml \
# 	-n preview-mads-harvester-k3s \
# 	port-forward service/proxy 22:22

# # Workspace: In a new shell SSH to the VM
# ssh ubuntu@127.0.0.1
