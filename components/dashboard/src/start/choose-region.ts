/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { getGitpodService } from "../service/service";

/**
 *
 * measureAndPickWorkspaceClusterRegion attempts multiple fetch calls on all available workspace cluster regions.
 * The first region to return those fetch attempts is set as workspace cluster preference.
 *
 * @returns void
 */
async function measureAndPickWorkspaceClusterRegion(): Promise<void> {
    const eps = await getGitpodService().server.listWorkspaceClusterRTTEndpoints();

    if (!!eps.lastMeasurement) {
        const lrm = Date.parse(eps.lastMeasurement);
        if (Date.now() - lrm < 6*60*60*1000) {
            // we checked within the last six hours. Nothing to do here.
            return;
        }
    }

    const region = await Promise.race(eps.candidates.map(ep => measureRTT(ep.endpoint, ep.region)));
    if (!region) {
        console.warn("did not find a prefered workspace cluster region");
        return;
    }

    await getGitpodService().server.setWorkspaceClusterPreferences({ region });
}

async function measureRTT(endpoint: string, region: string): Promise<string | undefined> {
    const laps = 5;
    let count = 0;
    for (let i = 0; i < laps; i++) {
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), 1000);

        try {
            await fetch(endpoint, {
                cache: "no-cache",
                signal: controller.signal,
            });
            count++;
        } catch (err) {
            console.debug(`failed to fetch RTT endpoint ${endpoint}: ${err}`);
        } finally {
            clearTimeout(abort);
        }
    }

    if (count < 5) {
        // we haven't completed all RTT measurements, hence take a penalty lap.
        await new Promise(resolve => setTimeout(resolve, laps * 1000));
        return;
    }

    return region;
}

export { measureAndPickWorkspaceClusterRegion };