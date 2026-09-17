import { CANONICAL_LOCALE, loadMeta, localeFiles } from "./lib.ts";

const repo = process.env.GITHUB_REPOSITORY;
// Deliberately not GITHUB_TOKEN: Actions' own token has no "administration"
// scope to grant at all, which is what made notify-maintainers.ts's assignee
// step 422 for anyone not already a collaborator. Managing collaborators
// needs a PAT (or GitHub App) with admin rights on this repo, stored
// separately so the day-to-day issues/contents token stays as narrow as it
// was.
const token = process.env.MAINTAINER_ACCESS_TOKEN;

if (!repo || !token) {
    console.error("GITHUB_REPOSITORY and MAINTAINER_ACCESS_TOKEN are required.");
    process.exit(1);
}

async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...init.headers,
        },
    });

    if (!res.ok && res.status !== 404) {
        throw new Error(
            `${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`,
        );
    }

    return res;
}

type Invitation = { invitee: { login: string } | null };

/**
 * Whether `handle` can already be assigned issues on this repo - a full
 * collaborator, or one invited but not yet accepted.
 *
 * Re-inviting an existing collaborator is a harmless no-op, but re-inviting a
 * pending one re-sends the email every run - this repo's own push-triggered
 * workflow would otherwise spam an invite on every unrelated locale commit
 * until the person gets around to accepting it.
 */
async function alreadyHasAccess(handle: string): Promise<boolean> {
    const permission = await api(`/collaborators/${handle}/permission`);
    if (permission.ok) return true;

    const invitations = await api("/invitations?per_page=100");
    if (!invitations.ok) return false;

    const pending = (await invitations.json()) as Invitation[];

    return pending.some(
        (invite) => invite.invitee?.login.toLowerCase() === handle.toLowerCase(),
    );
}

async function run() {
    const maintainers = new Set<string>();

    for (const file of localeFiles()) {
        const locale = file.replace(/\.json$/, "");
        if (locale === CANONICAL_LOCALE) continue;

        for (const handle of loadMeta(file).maintainers) maintainers.add(handle);
    }

    for (const handle of maintainers) {
        if (await alreadyHasAccess(handle)) {
            console.log(`${handle}: already has access`);
            continue;
        }

        /* Read-only: a maintainer here is translating JSON through PRs, not
         * pushing to main - the only thing this access needs to buy is
         * eligibility to be assigned the issue notify-maintainers.ts files
         * for them (GitHub requires at least read access for that), not the
         * ability to change code. */
        await api(`/collaborators/${handle}`, {
            method: "PUT",
            body: JSON.stringify({ permission: "pull" }),
        });
        console.log(`${handle}: invited (read-only)`);
    }
}

await run();
