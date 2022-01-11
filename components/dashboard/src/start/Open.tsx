/**
 * Copyright (c) 2022 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { User, Workspace } from "@gitpod/gitpod-protocol";
import React, { useContext, useEffect, useState } from "react";
import { getGitpodService } from "../service/service";
import { UserContext } from "../user-context";

type SearchResult = string;
type SearchData = SearchResult[];

const LOCAL_STORAGE_KEY = 'open-in-gitpod-search-data';
const MAX_DISPLAYED_ITEMS = 20;

export default function Open() {
    const { user } = useContext(UserContext);
    const [ searchQuery, setSearchQuery ] = useState<string>('');
    const [ searchResults, setSearchResults ] = useState<SearchResult[]>([]);
    const [ selectedSearchResult, setSelectedSearchResult ] = useState<SearchResult | undefined>();

    const onResults = (results: SearchResult[]) => {
        if (JSON.stringify(results) !== JSON.stringify(searchResults)) {
            setSearchResults(results);
            setSelectedSearchResult(results[0]);
        }
    }

    const search = async (query: string) => {
        setSearchQuery(query);
        await findResults(query, onResults);
        if (await refreshSearchData(query, user)) {
            // Re-run search if the underlying search data has changed
            await findResults(query, onResults);
        }
    }

    // Support pre-filling the search bar via the URL hash
    useEffect(() => {
        const onHashChange = () => {
            const hash = window.location.hash.slice(1);
            if (hash) {
                search(hash);
            }
        }
        onHashChange();
        window.addEventListener('hashchange', onHashChange, false);
        return () => {
            window.removeEventListener('hashchange', onHashChange, false);
        }
    }, []);

    // Up/Down keyboard navigation between results
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (!selectedSearchResult) {
            return;
        }
        const selectedIndex = searchResults.indexOf(selectedSearchResult);
        const select = (index: number) => {
            // Implement a true modulus in order to "wrap around" (e.g. `select(-1)` should select the last result)
            // Source: https://stackoverflow.com/a/4467559/3461173
            const n = Math.min(searchResults.length, MAX_DISPLAYED_ITEMS);
            setSelectedSearchResult(searchResults[((index % n) + n) % n]);
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            select(selectedIndex + 1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            select(selectedIndex - 1);
            return;
        }
    }

    const onSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        if (selectedSearchResult) {
            window.location.href = '/#' + selectedSearchResult;
        }
    }

    return <form className="mt-24 mx-auto w-96 flex flex-col items-stretch" onSubmit={onSubmit}>
        <h1 className="text-center">Open in Gitpod</h1>
        <div className="mt-8 flex px-4 rounded-xl border border-gray-300 dark:border-gray-500">
            <div className="py-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="16" height="16"><path fill="#A8A29E" d="M6 2a4 4 0 100 8 4 4 0 000-8zM0 6a6 6 0 1110.89 3.477l4.817 4.816a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 010 6z"/></svg>
            </div>
            <input type="search" className="flex-grow" placeholder="Repository" autoFocus value={searchQuery} onChange={e => search(e.target.value)} onKeyDown={onKeyDown} />
        </div>
        <div className="rounded-xl bg-gray-50 dark:bg-gray-800 flex flex-col" id="search-results">
            {searchResults.slice(0, MAX_DISPLAYED_ITEMS).map((result, index) =>
                <a className={`px-4 py-2 rounded-xl` + (result === selectedSearchResult ? ' bg-gray-100 dark:bg-gray-700' : '')} href={`/#${result}`} key={`search-result-${index}`}>
                    {result.split(searchQuery).map((segment, index) => <span>
                        {index === 0 ? <></> : <strong>{searchQuery}</strong>}
                        {segment}
                    </span>)}
                </a>
            )}
            {searchResults.length > MAX_DISPLAYED_ITEMS &&
                <span className="px-4 py-2 italic text-sm">{searchResults.length - MAX_DISPLAYED_ITEMS} results not shown</span>}
        </div>
    </form>;
}

function loadSearchData(): SearchData {
    const string = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!string) {
        return [];
    }
    try {
        const data = JSON.parse(string);
        return data;
    } catch(error) {
        console.warn('Could not load search data from local storage', error);
        return [];
    }
}

function saveSearchData(searchData: SearchData): void {
    try {
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(searchData));
    } catch(error) {
        console.warn('Could not save search data into local storage', error);
    }
}

let refreshSearchDataPromise: Promise<boolean> | undefined;
export async function refreshSearchData(query: string, user: User | undefined): Promise<boolean> {
    if (refreshSearchDataPromise) {
        // Another refresh is already in progress, no need to run another one in parallel.
        return refreshSearchDataPromise;
    }
    refreshSearchDataPromise = actuallyRefreshSearchData(query, user);
    const didChange = await refreshSearchDataPromise;
    refreshSearchDataPromise = undefined;
    return didChange;
}

// Fetch all possible search results and cache them into local storage
async function actuallyRefreshSearchData(query: string, user: User | undefined): Promise<boolean> {
    console.log('refreshing search data');
    let oldData = loadSearchData();
    let newData: SearchData = [];

    // Fetch all data sources in parallel for maximum speed (don't await before `Promise.allSettled(promises)` below!)
    const promises = [];

    // Example repositories
    promises.push(getGitpodService().server.getFeaturedRepositories().then(exampleRepos => {
        // console.log('got example repos', exampleRepos);
        exampleRepos.forEach(r => newData.push(r.url));
    }));

    // User repositories
    (user?.identities || []).forEach(identity => {
        const provider = {
            'Public-GitLab': 'gitlab.com',
            'Public-GitHub': 'github.com',
            'Public-Bitbucket': 'bitbucket.org',
        }[identity.authProviderId];
        if (!provider) {
            return;
        }
        promises.push(getGitpodService().server.getProviderRepositoriesForUser({ provider }).then(userRepos => {
            // console.log('got', provider, 'user repos', userRepos)
            userRepos.forEach(r => newData.push(r.cloneUrl.replace(/\.git$/, '')));
        }));
    });

    // Recent repositories
    promises.push(getGitpodService().server.getWorkspaces({ /* limit: 20 */ }).then(workspaces => {
        workspaces.forEach(ws => {
            const repoUrl = Workspace.getFullRepositoryUrl(ws.workspace);
            if (repoUrl) {
                newData.push(repoUrl);
            }
        });
    }));

    await Promise.allSettled(promises);

    const uniqueRepos = new Set();
    newData = newData
        .sort((a, b) => a > b ? 1 : -1)
        .filter(r => {
            if (uniqueRepos.has(r)) {
                return false;
            }
            uniqueRepos.add(r);
            return true;
        });

    if (JSON.stringify(oldData) !== JSON.stringify(newData)) {
        console.log('new data:', newData);
        saveSearchData(newData);
        return true;
    }
    return false;
}

async function findResults(query: string, onResults: (results: string[]) => void) {
    const searchData = loadSearchData();
    try {
        // If the query is a URL, and it's not present in the proposed results, "artificially" add it here.
        new URL(query);
        if (!searchData.includes(query)) {
            searchData.push(query);
        }
    } catch {
    }
    // console.log('searching', query, 'in', searchData);
    onResults(searchData.filter(result => result.includes(query)));
}
