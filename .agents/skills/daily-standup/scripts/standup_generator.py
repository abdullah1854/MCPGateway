#!/usr/bin/env python3
"""
Daily Standup Generator - Creates standup reports from git activity and GitHub PRs.
"""

import json
import subprocess
import sys
from datetime import datetime, timedelta
from typing import Optional


def get_git_commits(
    since: Optional[str] = None,
    author: Optional[str] = None,
    repo_path: str = "."
) -> list[dict]:
    """Get git commits from repository."""
    if since is None:
        since = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    cmd = [
        "git", "-C", repo_path, "log",
        f"--since={since}",
        "--format=%H|%s|%an|%ai",
        "--no-merges"
    ]

    if author:
        cmd.append(f"--author={author}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        commits = []
        for line in result.stdout.strip().split("\n"):
            if line:
                parts = line.split("|")
                if len(parts) >= 4:
                    commits.append({
                        "hash": parts[0][:7],
                        "message": parts[1],
                        "author": parts[2],
                        "date": parts[3]
                    })
        return commits
    except subprocess.CalledProcessError:
        return []


def categorize_commits(commits: list[dict]) -> dict[str, list[str]]:
    """Categorize commits by type based on conventional commits."""
    categories = {
        "features": [],
        "fixes": [],
        "refactoring": [],
        "docs": [],
        "tests": [],
        "other": []
    }

    for commit in commits:
        msg = commit["message"].lower()
        if msg.startswith("feat"):
            categories["features"].append(commit["message"])
        elif msg.startswith("fix"):
            categories["fixes"].append(commit["message"])
        elif msg.startswith("refactor"):
            categories["refactoring"].append(commit["message"])
        elif msg.startswith("docs"):
            categories["docs"].append(commit["message"])
        elif msg.startswith("test"):
            categories["tests"].append(commit["message"])
        else:
            categories["other"].append(commit["message"])

    # Remove empty categories
    return {k: v for k, v in categories.items() if v}


def generate_standup_report(
    accomplishments: list[str],
    planned: list[str],
    blockers: Optional[list[str]] = None,
    format: str = "markdown"
) -> str:
    """Generate formatted standup report."""

    if format == "markdown":
        report = f"""# Daily Standup - {datetime.now().strftime('%Y-%m-%d')}

## ✅ Yesterday's Accomplishments
"""
        for item in accomplishments:
            report += f"- {item}\n"

        report += "\n## 📋 Today's Plan\n"
        for item in planned:
            report += f"- {item}\n"

        if blockers:
            report += "\n## 🚧 Blockers\n"
            for item in blockers:
                report += f"- {item}\n"

        return report

    elif format == "slack":
        report = f"*Daily Standup - {datetime.now().strftime('%Y-%m-%d')}*\n\n"
        report += "*✅ Done:*\n"
        for item in accomplishments:
            report += f"• {item}\n"

        report += "\n*📋 Today:*\n"
        for item in planned:
            report += f"• {item}\n"

        if blockers:
            report += "\n*🚧 Blocked:*\n"
            for item in blockers:
                report += f"• {item}\n"

        return report

    elif format == "json":
        return json.dumps({
            "date": datetime.now().isoformat(),
            "accomplishments": accomplishments,
            "planned": planned,
            "blockers": blockers or []
        }, indent=2)

    return ""


def generate_from_git(
    repo_path: str = ".",
    author: Optional[str] = None,
    planned: Optional[list[str]] = None,
    blockers: Optional[list[str]] = None
) -> str:
    """Generate standup from git history."""
    commits = get_git_commits(repo_path=repo_path, author=author)
    categories = categorize_commits(commits)

    accomplishments = []
    if categories.get("features"):
        accomplishments.append(f"Added {len(categories['features'])} feature(s): {', '.join(categories['features'][:3])}")
    if categories.get("fixes"):
        accomplishments.append(f"Fixed {len(categories['fixes'])} bug(s)")
    if categories.get("refactoring"):
        accomplishments.append(f"Refactored {len(categories['refactoring'])} area(s)")
    if categories.get("docs"):
        accomplishments.append("Updated documentation")
    if categories.get("tests"):
        accomplishments.append("Added/updated tests")

    if not accomplishments:
        accomplishments = ["Continued work on current tasks"]

    return generate_standup_report(
        accomplishments=accomplishments,
        planned=planned or ["Continue current work items"],
        blockers=blockers
    )


def get_pr_activity(
    owner: str,
    repo: str,
    author: Optional[str] = None
) -> dict:
    """Get PR activity summary (requires gh CLI)."""
    try:
        cmd = ["gh", "pr", "list", "-R", f"{owner}/{repo}", "--json", "title,state,author,createdAt"]
        if author:
            cmd.extend(["--author", author])

        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        prs = json.loads(result.stdout)

        return {
            "open": [pr for pr in prs if pr["state"] == "OPEN"],
            "merged": [pr for pr in prs if pr["state"] == "MERGED"],
            "count": len(prs)
        }
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return {"open": [], "merged": [], "count": 0}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "--git":
            report = generate_from_git(
                repo_path=sys.argv[2] if len(sys.argv) > 2 else ".",
                planned=["Review PRs", "Continue feature work"]
            )
            print(report)

        elif cmd == "--commits":
            commits = get_git_commits()
            for c in commits:
                print(f"{c['hash']} - {c['message']}")

        elif cmd == "--example":
            report = generate_standup_report(
                accomplishments=[
                    "Completed user authentication feature",
                    "Fixed login redirect bug",
                    "Reviewed 3 PRs"
                ],
                planned=[
                    "Start on dashboard analytics",
                    "Write tests for auth module"
                ],
                blockers=[
                    "Waiting for API spec from backend team"
                ]
            )
            print(report)

        elif cmd == "--slack":
            report = generate_standup_report(
                accomplishments=["Completed feature X"],
                planned=["Work on feature Y"],
                format="slack"
            )
            print(report)
    else:
        print("Daily Standup Generator")
        print("Usage:")
        print("  --git [path]    Generate from git history")
        print("  --commits       Show recent commits")
        print("  --example       Show example report")
        print("  --slack         Generate Slack-formatted report")
