#!/usr/bin/env python3
"""
Orchestrates an autonomous review loop using OpenCode CLI (opencode run) to assess
open Pull Requests and Issues on Heretek-AI/awesome-opencode for quality and OpenCode V2 compatibility.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

REPO = "Heretek-AI/awesome-opencode"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "../.."))
PROMPT_FILE = os.path.join(PROJECT_ROOT, "prompts/opencode-review-loop.md")
REVIEWS_DIR = os.path.join(PROJECT_ROOT, "reviews")
STATE_FILE = os.path.join(REVIEWS_DIR, "review_state.json")
RESULTS_FILE = os.path.join(REVIEWS_DIR, "review_results.json")
SUMMARY_FILE = os.path.join(REVIEWS_DIR, "summary.md")

def load_prompt():
    with open(PROMPT_FILE, "r", encoding="utf-8") as f:
        return f.read()

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"processed_prs": {}, "processed_issues": {}}

def save_state(state):
    os.makedirs(REVIEWS_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

def save_results(results):
    os.makedirs(REVIEWS_DIR, exist_ok=True)
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

def append_to_summary(item_type, num, title, target_name, verdict, v2_status, confidence, reason):
    os.makedirs(REVIEWS_DIR, exist_ok=True)
    header_needed = not os.path.exists(SUMMARY_FILE) or os.path.getsize(SUMMARY_FILE) == 0
    with open(SUMMARY_FILE, "a", encoding="utf-8") as f:
        if header_needed:
            f.write("# Awesome-OpenCode Backlog Review Summary\n\n")
            f.write("Autonomous review powered by OpenCode evaluating OpenCode V2 compatibility and catalog quality.\n\n")
            f.write("| Type | # | Title | Target Name | V2 Status | Verdict | Conf | Reason |\n")
            f.write("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n")
        f.write(f"| {item_type} | [{num}](https://github.com/{REPO}/{'pull' if item_type == 'PR' else 'issues'}/{num}) | {title[:35]} | {target_name[:25]} | `{v2_status}` | **`{verdict}`** | {confidence}% | {reason} |\n")

def fetch_open_prs():
    print("Fetching open PRs from GitHub...")
    out = subprocess.check_output([
        "gh", "pr", "list",
        "-R", REPO,
        "--state", "open",
        "--limit", "600",
        "--json", "number,title,body,author,headRefName,createdAt,url"
    ], text=True)
    prs = json.loads(out)
    prs.sort(key=lambda x: x["number"])
    return prs

def fetch_open_issues():
    print("Fetching open issues from GitHub...")
    out = subprocess.check_output([
        "gh", "issue", "list",
        "-R", REPO,
        "--state", "open",
        "--limit", "100",
        "--json", "number,title,body,author,createdAt,url"
    ], text=True)
    issues = json.loads(out)
    issues.sort(key=lambda x: x["number"])
    return issues

def inspect_target_repo(repo_url):
    """Gathers factual evidence from target GitHub repo (commit dates, package.json dependencies)."""
    facts = {"repo_url": repo_url, "exists": False}
    match = re.search(r'github\.com/([^/]+)/([^/#?]+)', repo_url or "")
    if not match:
        return facts

    owner, repo_name = match.group(1), match.group(2).removesuffix(".git")
    api_url = f"https://api.github.com/repos/{owner}/{repo_name}"
    
    # 1. Check repo status via gh api
    try:
        raw = subprocess.check_output(["gh", "api", api_url, "--jq", "{archived, pushed_at, stargazers_count, default_branch, description}"], text=True)
        repo_data = json.loads(raw)
        facts["exists"] = True
        facts["archived"] = repo_data.get("archived", False)
        facts["pushed_at"] = repo_data.get("pushed_at")
        facts["stars"] = repo_data.get("stargazers_count", 0)
        facts["default_branch"] = repo_data.get("default_branch", "main")
        facts["description"] = repo_data.get("description", "")
    except Exception as e:
        facts["error"] = str(e)
        return facts

    # 2. Check package.json for @opencode/plugin or @opencode-ai/plugin
    branch = facts.get("default_branch", "HEAD")
    pkg_url = f"https://raw.githubusercontent.com/{owner}/{repo_name}/{branch}/package.json"
    try:
        req = urllib.request.Request(pkg_url, headers={"User-Agent": "OpenCode-Reviewer"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            pkg_data = json.loads(resp.read().decode("utf-8"))
            deps = {}
            deps.update(pkg_data.get("dependencies", {}))
            deps.update(pkg_data.get("devDependencies", {}))
            deps.update(pkg_data.get("peerDependencies", {}))
            
            opencode_deps = {k: v for k, v in deps.items() if "opencode" in k.lower()}
            facts["opencode_dependencies"] = opencode_deps
            if "@opencode/plugin" in opencode_deps:
                facts["v2_plugin_package_detected"] = True
            if "@opencode-ai/plugin" in opencode_deps:
                facts["v1_plugin_package_detected"] = True
    except Exception:
        facts["package_json_found"] = False

    return facts

def get_pr_diff_files(pr_number, head_ref):
    """Retrieves diff or file list from git or gh CLI."""
    try:
        out = subprocess.check_output([
            "gh", "pr", "view", str(pr_number),
            "-R", REPO,
            "--json", "files"
        ], text=True)
        data = json.loads(out)
        files = data.get("files", [])
        return files
    except Exception:
        return []

def get_pr_file_content(head_ref, file_path):
    """Fetches the content of a file from the PR branch."""
    ref = f"origin/{head_ref}"
    try:
        out = subprocess.check_output(["git", "show", f"{ref}:{file_path}"], text=True)
        return out
    except Exception:
        # Fallback to local ref
        try:
            return subprocess.check_output(["git", "show", f"refs/remotes/{head_ref}:{file_path}"], text=True)
        except Exception:
            return None

def invoke_opencode_review(system_prompt, item_context, model=None):
    """Invokes opencode run with the formatted prompt."""
    combined_message = (
        f"{system_prompt}\n\n"
        f"---\n\n"
        f"# ITEM TO REVIEW NOW\n\n"
        f"{item_context}\n\n"
        f"Please inspect the facts above and provide your complete review and assessment.\n"
        f"You MUST include the final assessment in the requested JSON block."
    )

    cmd = ["opencode", "run"]
    if model:
        cmd.extend(["-m", model])
    cmd.append(combined_message)

    try:
        out = subprocess.check_output(cmd, text=True, timeout=120)
        return out
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "OpenCode review timed out after 120s"})
    except subprocess.CalledProcessError as e:
        return f"OpenCode run failed with exit code {e.returncode}: {e.output}"

def parse_json_verdict(raw_output):
    """Extracts JSON block from OpenCode output."""
    match = re.search(r'```json\s*(\{.*?\})\s*```', raw_output, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
    # Fallback search for bare JSON object
    match2 = re.search(r'(\{[\s\S]*"verdict"[\s\S]*\})', raw_output)
    if match2:
        try:
            return json.loads(match2.group(1))
        except Exception:
            pass
    return None

def review_pr(pr, system_prompt, dry_run=False, model=None):
    num = pr["number"]
    title = pr["title"]
    head_ref = pr.get("headRefName", f"upstream-pr/{num}")
    print(f"\n==================================================")
    print(f"🔍 Reviewing PR #{num}: {title[:60]}")
    print(f"==================================================")

    files = get_pr_diff_files(num, head_ref)
    yaml_files = [f["path"] for f in files if f.get("path", "").startswith("data/") and f.get("path", "").endswith(".yaml")]
    
    yaml_content = None
    target_repo_url = None
    if yaml_files:
        yaml_content = get_pr_file_content(head_ref, yaml_files[0])
        if yaml_content:
            repo_match = re.search(r'repo:\s*([^\s\n]+)', yaml_content)
            if repo_match:
                target_repo_url = repo_match.group(1)

    # Fallback to searching body if no yaml repo found
    if not target_repo_url:
        candidates = re.findall(r'https?://github\.com/[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-]+', pr.get("body", ""))
        for c in candidates:
            if not any(skip in c for skip in ("awesome-opencode", "Heretek-AI", "sindresorhus", "anomalyco/opencode")):
                target_repo_url = c
                break

    # Inspect target repo facts
    facts = {}
    if target_repo_url:
        print(f"  Investigating target repository: {target_repo_url}...")
        facts = inspect_target_repo(target_repo_url)

    item_context = (
        f"### Pull Request Metadata\n"
        f"- **PR Number**: #{num}\n"
        f"- **Title**: {title}\n"
        f"- **Author**: {pr.get('author', {}).get('login', 'unknown')}\n"
        f"- **Created At**: {pr.get('createdAt')}\n"
        f"- **Changed Files**: {', '.join(f.get('path', '') for f in files)}\n\n"
        f"### Submitted YAML Content\n"
        f"```yaml\n{yaml_content or '*No YAML file found in PR*'}\n```\n\n"
        f"### PR Body / Description\n"
        f"{pr.get('body', '')}\n\n"
        f"### Verified Target Repository Facts\n"
        f"```json\n{json.dumps(facts, indent=2)}\n```"
    )

    if dry_run:
        print("  [DRY-RUN] Item context prepared. OpenCode execution skipped.")
        return {
            "item_type": "PR",
            "item_number": num,
            "title": title,
            "verdict": "DRY_RUN",
            "v2_status": "UNKNOWN",
            "confidence_score": 0,
            "summary_reason": "Dry-run execution",
            "facts": facts
        }

    print("  Running OpenCode evaluation...")
    raw_response = invoke_opencode_review(system_prompt, item_context, model=model)
    verdict = parse_json_verdict(raw_response)
    if not verdict:
        print("  ⚠️ Warning: Could not parse structured JSON from OpenCode output. Storing raw output.")
        verdict = {
            "item_type": "PR",
            "item_number": num,
            "title": title,
            "verdict": "PARSE_ERROR",
            "v2_status": "UNKNOWN",
            "confidence_score": 0,
            "summary_reason": "Failed to parse structured JSON from model",
            "raw_output": raw_response
        }
    else:
        print(f"  ✅ Verdict: {verdict.get('verdict')} | V2 Status: {verdict.get('opencode_v2_status')} (Confidence: {verdict.get('confidence_score')}%)")
        print(f"  💡 Rationale: {verdict.get('summary_reason')}")

    return verdict

def review_issue(issue, system_prompt, dry_run=False, model=None):
    num = issue["number"]
    title = issue["title"]
    print(f"\n==================================================")
    print(f"🔍 Reviewing Issue #{num}: {title[:60]}")
    print(f"==================================================")

    body = issue.get("body", "")
    target_repo_url = None
    body_match = re.search(r'https?://github\.com/[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-]+', body)
    if body_match:
        target_repo_url = body_match.group(0)

    facts = {}
    if target_repo_url:
        print(f"  Investigating target repository: {target_repo_url}...")
        facts = inspect_target_repo(target_repo_url)

    item_context = (
        f"### Issue Metadata\n"
        f"- **Issue Number**: #{num}\n"
        f"- **Title**: {title}\n"
        f"- **Author**: {issue.get('author', {}).get('login', 'unknown')}\n"
        f"- **Created At**: {issue.get('createdAt')}\n\n"
        f"### Issue Body\n"
        f"{body}\n\n"
        f"### Verified Target Repository Facts\n"
        f"```json\n{json.dumps(facts, indent=2)}\n```"
    )

    if dry_run:
        print("  [DRY-RUN] Item context prepared. OpenCode execution skipped.")
        return {
            "item_type": "ISSUE",
            "item_number": num,
            "title": title,
            "verdict": "DRY_RUN",
            "v2_status": "UNKNOWN",
            "confidence_score": 0,
            "summary_reason": "Dry-run execution",
            "facts": facts
        }

    print("  Running OpenCode evaluation...")
    raw_response = invoke_opencode_review(system_prompt, item_context, model=model)
    verdict = parse_json_verdict(raw_response)
    if not verdict:
        print("  ⚠️ Warning: Could not parse structured JSON from OpenCode output.")
        verdict = {
            "item_type": "ISSUE",
            "item_number": num,
            "title": title,
            "verdict": "PARSE_ERROR",
            "v2_status": "UNKNOWN",
            "confidence_score": 0,
            "summary_reason": "Failed to parse structured JSON from model",
            "raw_output": raw_response
        }
    else:
        print(f"  ✅ Verdict: {verdict.get('verdict')} | V2 Status: {verdict.get('opencode_v2_status')} (Confidence: {verdict.get('confidence_score')}%)")
        print(f"  💡 Rationale: {verdict.get('summary_reason')}")

    return verdict

def main():
    parser = argparse.ArgumentParser(description="Run OpenCode review loop over open PRs and issues.")
    parser.add_argument("--limit", type=int, default=None, help="Maximum number of items to review")
    parser.add_argument("--pr", type=int, default=None, help="Review a single PR by number")
    parser.add_argument("--issue", type=int, default=None, help="Review a single issue by number")
    parser.add_argument("--prs-only", action="store_true", help="Review only PRs")
    parser.add_argument("--issues-only", action="store_true", help="Review only issues")
    parser.add_argument("--dry-run", action="store_true", help="Collect data without calling OpenCode LLM")
    parser.add_argument("--model", type=str, default=None, help="Model override for OpenCode (e.g. deepseek/deepseek-flash)")
    parser.add_argument("--reset", action="store_true", help="Reset state file before running")
    args = parser.parse_args()

    if args.reset and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
        print("Cleared review state.")

    state = load_state()
    system_prompt = load_prompt()
    processed_count = 0

    # 1. Single PR Mode
    if args.pr:
        prs = fetch_open_prs()
        target = next((p for p in prs if p["number"] == args.pr), None)
        if not target:
            sys.exit(f"PR #{args.pr} not found or not open.")
        verdict = review_pr(target, system_prompt, dry_run=args.dry_run, model=args.model)
        state["processed_prs"][str(args.pr)] = verdict
        save_state(state)
        append_to_summary("PR", args.pr, target["title"], verdict.get("target_name", ""), verdict.get("verdict", ""), verdict.get("opencode_v2_status", ""), verdict.get("confidence_score", 0), verdict.get("summary_reason", ""))
        return

    # 2. Single Issue Mode
    if args.issue:
        issues = fetch_open_issues()
        target = next((i for i in issues if i["number"] == args.issue), None)
        if not target:
            sys.exit(f"Issue #{args.issue} not found or not open.")
        verdict = review_issue(target, system_prompt, dry_run=args.dry_run, model=args.model)
        state["processed_issues"][str(args.issue)] = verdict
        save_state(state)
        append_to_summary("ISSUE", args.issue, target["title"], verdict.get("target_name", ""), verdict.get("verdict", ""), verdict.get("opencode_v2_status", ""), verdict.get("confidence_score", 0), verdict.get("summary_reason", ""))
        return

    # 3. Batch Loop Mode
    items_to_process = []
    if not args.prs_only and not args.issues_only:
        # Interleave or process issues first then PRs
        issues = fetch_open_issues()
        prs = fetch_open_prs()
        for i in issues:
            if str(i["number"]) not in state["processed_issues"]:
                items_to_process.append(("ISSUE", i))
        for p in prs:
            if str(p["number"]) not in state["processed_prs"]:
                items_to_process.append(("PR", p))
    elif args.issues_only:
        issues = fetch_open_issues()
        for i in issues:
            if str(i["number"]) not in state["processed_issues"]:
                items_to_process.append(("ISSUE", i))
    elif args.prs_only:
        prs = fetch_open_prs()
        for p in prs:
            if str(p["number"]) not in state["processed_prs"]:
                items_to_process.append(("PR", p))

    print(f"\nUnreviewed backlog items in queue: {len(items_to_process)}")
    if args.limit:
        items_to_process = items_to_process[:args.limit]
        print(f"Limiting to first {len(items_to_process)} items as requested.")

    for idx, (kind, item) in enumerate(items_to_process, 1):
        num = item["number"]
        print(f"\n[{idx}/{len(items_to_process)}] Processing {kind} #{num}...")
        if kind == "PR":
            verdict = review_pr(item, system_prompt, dry_run=args.dry_run, model=args.model)
            state["processed_prs"][str(num)] = verdict
        else:
            verdict = review_issue(item, system_prompt, dry_run=args.dry_run, model=args.model)
            state["processed_issues"][str(num)] = verdict

        save_state(state)
        append_to_summary(
            kind, num, item["title"],
            verdict.get("target_name", ""),
            verdict.get("verdict", ""),
            verdict.get("opencode_v2_status", ""),
            verdict.get("confidence_score", 0),
            verdict.get("summary_reason", "")
        )
        processed_count += 1
        time.sleep(1.0)

    print(f"\n🎉 Review loop batch complete! Processed {processed_count} items.")
    print(f"Results recorded in {SUMMARY_FILE} and {STATE_FILE}")

if __name__ == "__main__":
    main()
