#!/usr/bin/env python3
"""
Imports all open pull requests from awesome-opencode/awesome-opencode to Heretek-AI/awesome-opencode:
1. Pushes PR commit refs to origin branches (upstream-pr/<number>)
2. Recreates the PRs on Heretek-AI/awesome-opencode against main with complete provenance and author attribution.
3. Automatically tracks progress in upstream_prs_map.json so runs are idempotent and resumable.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

UPSTREAM_REPO = "awesome-opencode/awesome-opencode"
TARGET_REPO = "Heretek-AI/awesome-opencode"
MAPPING_FILE = os.path.join(os.path.dirname(__file__), "upstream_prs_map.json")

def get_token():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        try:
            token = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
        except Exception as e:
            sys.exit(f"Failed to get GitHub token via gh CLI: {e}")
    return token

TOKEN = get_token()

def gh_api_request(url, method="GET", data=None):
    headers = {
        "Authorization": f"token {TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Heretek-HardFork-PR-Migration"
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"HTTPError {e.code} for {method} {url}: {error_body}", file=sys.stderr)
        raise

def sanitize_mentions(text):
    if not text:
        return ""
    def replace_mention(match):
        prefix = match.group(1)
        username = match.group(2)
        return f"{prefix}[@{username}](https://github.com/{username})"
    return re.sub(r'(^|[\s(])@([a-zA-Z0-9_\-]+)', replace_mention, text)

def fetch_upstream_open_prs():
    print(f"Fetching open PRs from {UPSTREAM_REPO}...")
    cmd = [
        "gh", "pr", "list",
        "-R", UPSTREAM_REPO,
        "--state", "open",
        "--limit", "600",
        "--json", "number,title,body,author,createdAt,headRefName,url"
    ]
    out = subprocess.check_output(cmd, text=True)
    prs = json.loads(out)
    prs.sort(key=lambda x: x["number"])
    print(f"Found {len(prs)} open PRs on upstream.")
    return prs

def push_pr_branches_in_batches(prs, batch_size=50):
    print(f"Checking and pushing {len(prs)} PR branches to origin...")
    refspecs = []
    for pr in prs:
        num = pr["number"]
        local_ref = f"refs/remotes/upstream-pr/{num}"
        # verify local ref exists
        res = subprocess.run(["git", "rev-parse", "--verify", local_ref], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0:
            refspecs.append(f"{local_ref}:refs/heads/upstream-pr/{num}")
        else:
            print(f"Warning: local ref {local_ref} not found for PR #{num}!", file=sys.stderr)

    for i in range(0, len(refspecs), batch_size):
        chunk = refspecs[i:i + batch_size]
        print(f"Pushing branches batch {i+1} to {min(i + batch_size, len(refspecs))} of {len(refspecs)}...")
        cmd = ["git", "push", "origin"] + chunk
        subprocess.check_call(cmd)

    print("All PR branches pushed successfully!")

def load_mapping():
    if os.path.exists(MAPPING_FILE):
        with open(MAPPING_FILE, "r") as f:
            return json.load(f)
    return {}

def save_mapping(mapping):
    with open(MAPPING_FILE, "w") as f:
        json.dump(mapping, f, indent=2)

def create_target_pr(pr):
    num = pr["number"]
    title = pr["title"]
    author = pr["author"]["login"] if pr.get("author") else "unknown"
    created_at = pr["createdAt"]
    head_ref = pr.get("headRefName", "branch")
    sanitized_body = sanitize_mentions(pr.get("body") or "*No description provided.*")

    body = (
        f"> [!NOTE]\n"
        f"> **Original Pull Request**: [{UPSTREAM_REPO}#{num}](https://github.com/{UPSTREAM_REPO}/pull/{num})\n"
        f"> **Original Author**: [@{author}](https://github.com/{author})\n"
        f"> **Submitted At**: `{created_at}`\n"
        f"> **Original Branch**: `{head_ref}`\n\n"
        f"---\n\n"
        f"{sanitized_body}"
    )

    url = f"https://api.github.com/repos/{TARGET_REPO}/pulls"
    payload = {
        "title": f"[Upstream #{num}] {title}",
        "head": f"upstream-pr/{num}",
        "base": "main",
        "body": body,
        "maintainer_can_modify": True
    }
    return gh_api_request(url, method="POST", data=payload)

def main():
    prs = fetch_upstream_open_prs()
    mapping = load_mapping()

    # Step 1: Ensure all branches are pushed to origin
    push_pr_branches_in_batches(prs)

    # Step 2: Create PRs on GitHub
    print(f"\nCreating {len(prs)} Pull Requests on {TARGET_REPO}...")
    for idx, pr in enumerate(prs, 1):
        num = pr["number"]
        if str(num) in mapping:
            print(f"[{idx}/{len(prs)}] PR #{num} already migrated as {mapping[str(num)]['pr_url']}. Skipping.")
            continue

        print(f"[{idx}/{len(prs)}] Creating PR for Upstream #{num}: {pr['title'][:50]}...")
        retries = 5
        backoff = 30
        while retries > 0:
            try:
                new_pr = create_target_pr(pr)
                pr_url = new_pr.get("html_url")
                new_num = new_pr.get("number")
                print(f"  ✓ Created PR #{new_num} -> {pr_url}")
                mapping[str(num)] = {
                    "upstream_number": num,
                    "new_pr_number": new_num,
                    "pr_url": pr_url,
                    "title": pr["title"]
                }
                save_mapping(mapping)
                time.sleep(1.8)  # Rate limiting sleep
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 429):
                    print(f"  Secondary rate limit hit! Sleeping for {backoff}s before retry...", file=sys.stderr)
                    time.sleep(backoff)
                    backoff *= 2
                    retries -= 1
                elif e.code == 422:
                    # Likely branch has no diff against main or was already merged/empty
                    error_text = str(e)
                    print(f"  Unprocessable Entity (422) for PR #{num} (possibly already merged or identical to main). Recording as skipped.", file=sys.stderr)
                    mapping[str(num)] = {
                        "upstream_number": num,
                        "status": "skipped_422",
                        "title": pr["title"]
                    }
                    save_mapping(mapping)
                    break
                else:
                    print(f"  HTTP error {e.code} for PR #{num}: {e}", file=sys.stderr)
                    time.sleep(5)
                    retries -= 1
            except Exception as e:
                print(f"  Unexpected error for PR #{num}: {e}", file=sys.stderr)
                time.sleep(5)
                retries -= 1

    print("\nPR migration complete!")
    print(f"Total processed PRs: {len(mapping)} / {len(prs)}")

if __name__ == "__main__":
    main()
