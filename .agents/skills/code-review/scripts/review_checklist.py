"""
Code Review Checklist Generator

Generates a customized code review checklist based on language and focus area.

Usage:
    python review_checklist.py --language typescript --focus security
"""

from typing import List, Dict, Optional
import argparse


def get_security_checklist() -> List[str]:
    """Security-focused review items."""
    return [
        "No hardcoded credentials, API keys, or secrets",
        "Input validation on all user inputs",
        "SQL injection prevention (parameterized queries)",
        "XSS prevention (proper escaping/encoding)",
        "Authentication/authorization checks in place",
        "Sensitive data properly encrypted",
        "No exposed debug endpoints or logs",
        "CORS properly configured",
        "Rate limiting on sensitive endpoints",
    ]


def get_performance_checklist() -> List[str]:
    """Performance-focused review items."""
    return [
        "No N+1 query problems",
        "Proper indexing for database queries",
        "Pagination for large data sets",
        "Caching where appropriate",
        "No memory leaks (cleanup in useEffect, listeners)",
        "Lazy loading for heavy components/modules",
        "Optimized loops and algorithms",
        "No blocking operations on main thread",
    ]


def get_maintainability_checklist() -> List[str]:
    """Maintainability-focused review items."""
    return [
        "Code follows project conventions",
        "Functions are single-purpose (<20 lines ideal)",
        "Clear, descriptive naming",
        "No magic numbers/strings (use constants)",
        "DRY - no duplicated code",
        "Proper error handling",
        "Comments explain 'why', not 'what'",
        "Types properly defined (no 'any' abuse)",
    ]


def get_testing_checklist() -> List[str]:
    """Testing-focused review items."""
    return [
        "Unit tests for business logic",
        "Edge cases covered",
        "Error scenarios tested",
        "Mocks used appropriately",
        "Tests are readable and maintainable",
    ]


def get_language_checklist(language: str) -> List[str]:
    """Language-specific review items."""
    checklists = {
        "typescript": [
            "Proper type definitions (avoid any)",
            "Interfaces for complex objects",
            "Enums for fixed sets of values",
            "Null checks (strictNullChecks)",
            "No type assertions without validation",
        ],
        "python": [
            "Type hints used",
            "Docstrings for public functions",
            "Context managers for resources",
            "List comprehensions where appropriate",
            "No mutable default arguments",
        ],
        "sql": [
            "USE statement at start for multi-DB servers",
            "Proper JOINs (avoid cartesian products)",
            "WHERE clause optimization (indexed columns first)",
            "Avoid SELECT * in production",
            "Transaction handling for multiple operations",
        ],
        "csharp": [
            "Proper async/await usage",
            "IDisposable implemented where needed",
            "Null-conditional operators used",
            "LINQ used efficiently",
            "Exception handling hierarchy",
        ],
    }
    return checklists.get(language.lower(), [])


def generate_checklist(
    language: str = "typescript",
    focus: str = "all"
) -> Dict[str, List[str]]:
    """
    Generate a complete review checklist.

    Args:
        language: Programming language (typescript, python, sql, csharp)
        focus: Focus area (all, security, performance, maintainability)

    Returns:
        Dictionary with categorized checklist items
    """
    checklist = {}

    if focus in ("all", "security"):
        checklist["Security"] = get_security_checklist()

    if focus in ("all", "performance"):
        checklist["Performance"] = get_performance_checklist()

    if focus in ("all", "maintainability"):
        checklist["Maintainability"] = get_maintainability_checklist()

    if focus == "all":
        checklist["Testing"] = get_testing_checklist()

    # Always include language-specific checks
    lang_checks = get_language_checklist(language)
    if lang_checks:
        checklist[f"{language.title()} Specific"] = lang_checks

    return checklist


def format_checklist(checklist: Dict[str, List[str]]) -> str:
    """Format checklist as markdown."""
    output = ["# Code Review Checklist\n"]

    for category, items in checklist.items():
        output.append(f"## {category}\n")
        for item in items:
            output.append(f"- [ ] {item}")
        output.append("")

    output.append("## Quick Verdict\n")
    output.append("**Overall**: [ ] Approve [ ] Request Changes [ ] Comment\n")
    output.append("**Summary**: <1-2 sentences>\n")
    output.append("**Critical Issues**: <blocking issues>\n")
    output.append("**Suggestions**: <nice-to-haves>")

    return "\n".join(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate code review checklist")
    parser.add_argument("--language", default="typescript",
                        choices=["typescript", "python", "sql", "csharp"])
    parser.add_argument("--focus", default="all",
                        choices=["all", "security", "performance", "maintainability"])

    args = parser.parse_args()

    checklist = generate_checklist(args.language, args.focus)
    print(format_checklist(checklist))
