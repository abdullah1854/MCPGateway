#!/usr/bin/env python3
"""
SQL Analyzer - Analyzes SQL queries for performance and best practices.
"""

import json
import re
import sys
from typing import Optional


# Anti-patterns and their fixes
SQL_ANTIPATTERNS = {
    "select_star": {
        "pattern": r"SELECT\s+\*",
        "description": "SELECT * retrieves all columns unnecessarily",
        "severity": "medium",
        "fix": "List only the columns you need"
    },
    "no_where_clause": {
        "pattern": r"(UPDATE|DELETE)\s+\w+\s*(?!.*WHERE)",
        "description": "UPDATE/DELETE without WHERE affects all rows",
        "severity": "critical",
        "fix": "Add WHERE clause to limit affected rows"
    },
    "like_leading_wildcard": {
        "pattern": r"LIKE\s+['\"]%",
        "description": "LIKE with leading wildcard prevents index usage",
        "severity": "high",
        "fix": "Consider full-text search or remove leading wildcard"
    },
    "or_instead_of_in": {
        "pattern": r"(\w+)\s*=\s*['\"]?\w+['\"]?\s+OR\s+\1\s*=",
        "description": "Multiple OR conditions on same column",
        "severity": "low",
        "fix": "Use IN clause instead"
    },
    "not_in_null_issue": {
        "pattern": r"NOT\s+IN\s*\(",
        "description": "NOT IN can have unexpected NULL behavior",
        "severity": "medium",
        "fix": "Use NOT EXISTS or handle NULLs explicitly"
    },
    "implicit_conversion": {
        "pattern": r"WHERE\s+\w+\s*=\s*'?\d+'?",
        "description": "Potential implicit type conversion",
        "severity": "low",
        "fix": "Ensure types match to prevent conversion overhead"
    },
    "order_by_ordinal": {
        "pattern": r"ORDER\s+BY\s+\d+",
        "description": "ORDER BY with ordinal position is fragile",
        "severity": "low",
        "fix": "Use column names instead"
    },
    "count_star_with_where": {
        "pattern": r"COUNT\s*\(\s*\*\s*\).*WHERE",
        "description": "COUNT(*) with WHERE may not use covering index",
        "severity": "low",
        "fix": "Consider COUNT(indexed_column) if applicable"
    }
}


# Index suggestions
INDEX_SUGGESTIONS = {
    "where_column": {
        "description": "Add index on frequently filtered columns",
        "pattern": r"WHERE\s+(\w+)\s*[=<>]",
        "suggestion": "CREATE INDEX idx_{table}_{column} ON {table}({column})"
    },
    "join_column": {
        "description": "Add index on join columns",
        "pattern": r"JOIN\s+\w+\s+\w+\s+ON\s+\w+\.(\w+)\s*=",
        "suggestion": "Ensure indexes exist on both sides of JOIN columns"
    },
    "order_by_column": {
        "description": "Add index for ORDER BY optimization",
        "pattern": r"ORDER\s+BY\s+(\w+)",
        "suggestion": "Consider index on ORDER BY columns for large result sets"
    }
}


def analyze_query(sql: str) -> list[dict]:
    """Analyze a SQL query for anti-patterns."""
    issues = []
    sql_upper = sql.upper()

    for name, antipattern in SQL_ANTIPATTERNS.items():
        if re.search(antipattern["pattern"], sql_upper, re.IGNORECASE):
            issues.append({
                "type": name,
                "description": antipattern["description"],
                "severity": antipattern["severity"],
                "fix": antipattern["fix"]
            })

    return issues


def suggest_indexes(sql: str) -> list[str]:
    """Suggest potential indexes based on query."""
    suggestions = []

    for name, pattern in INDEX_SUGGESTIONS.items():
        matches = re.findall(pattern["pattern"], sql, re.IGNORECASE)
        if matches:
            suggestions.append(f"{pattern['description']}: {pattern['suggestion']}")

    return suggestions


def format_query(sql: str) -> str:
    """Format SQL query for readability."""
    keywords = [
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT JOIN',
        'RIGHT JOIN', 'INNER JOIN', 'ON', 'GROUP BY', 'ORDER BY',
        'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INSERT INTO', 'VALUES',
        'UPDATE', 'SET', 'DELETE FROM'
    ]

    formatted = sql.strip()

    for keyword in keywords:
        # Add newline before keyword
        formatted = re.sub(
            rf'(\s+)({keyword})\s+',
            rf'\n\2 ',
            formatted,
            flags=re.IGNORECASE
        )

    return formatted.strip()


def estimate_complexity(sql: str) -> dict:
    """Estimate query complexity."""
    sql_upper = sql.upper()

    score = 1
    factors = []

    # Count JOINs
    join_count = len(re.findall(r'\bJOIN\b', sql_upper))
    if join_count > 0:
        score += join_count * 2
        factors.append(f"{join_count} JOIN(s)")

    # Subqueries
    subquery_count = sql_upper.count('SELECT') - 1
    if subquery_count > 0:
        score += subquery_count * 3
        factors.append(f"{subquery_count} subquery(ies)")

    # GROUP BY
    if 'GROUP BY' in sql_upper:
        score += 2
        factors.append("GROUP BY")

    # DISTINCT
    if 'DISTINCT' in sql_upper:
        score += 1
        factors.append("DISTINCT")

    # ORDER BY
    if 'ORDER BY' in sql_upper:
        score += 1
        factors.append("ORDER BY")

    # Window functions
    if re.search(r'OVER\s*\(', sql_upper):
        score += 3
        factors.append("Window function(s)")

    complexity = "low" if score < 5 else "medium" if score < 10 else "high"

    return {
        "score": score,
        "complexity": complexity,
        "factors": factors
    }


def generate_explain_plan(sql: str, dialect: str = "mssql") -> str:
    """Generate EXPLAIN/execution plan query."""
    if dialect == "mssql":
        return f"""-- Enable execution plan
SET SHOWPLAN_ALL ON;
GO
{sql}
GO
SET SHOWPLAN_ALL OFF;

-- Or for graphical plan in SSMS:
-- Include Actual Execution Plan (Ctrl+M)"""

    elif dialect == "postgres":
        return f"""EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
{sql};"""

    elif dialect == "mysql":
        return f"""EXPLAIN ANALYZE
{sql};"""

    return f"-- Explain for {dialect} not implemented"


def generate_analysis_report(sql: str) -> str:
    """Generate comprehensive analysis report."""
    report = "# SQL Analysis Report\n\n"

    # Formatted query
    report += "## Query\n```sql\n"
    report += format_query(sql)
    report += "\n```\n\n"

    # Complexity
    complexity = estimate_complexity(sql)
    report += f"## Complexity: {complexity['complexity'].upper()}\n"
    report += f"Score: {complexity['score']}/10\n"
    if complexity['factors']:
        report += "Factors:\n"
        for factor in complexity['factors']:
            report += f"- {factor}\n"
    report += "\n"

    # Issues
    issues = analyze_query(sql)
    if issues:
        report += f"## Issues Found ({len(issues)})\n\n"
        for issue in issues:
            icon = "🔴" if issue["severity"] == "critical" else "🟡" if issue["severity"] == "high" else "🟢"
            report += f"### {icon} {issue['type']}\n"
            report += f"**Severity**: {issue['severity']}\n"
            report += f"**Issue**: {issue['description']}\n"
            report += f"**Fix**: {issue['fix']}\n\n"
    else:
        report += "## ✅ No significant issues found\n\n"

    # Index suggestions
    suggestions = suggest_indexes(sql)
    if suggestions:
        report += "## Index Suggestions\n"
        for suggestion in suggestions:
            report += f"- {suggestion}\n"

    return report


def optimize_query(sql: str) -> str:
    """Suggest optimized version of query."""
    optimized = sql

    # Replace SELECT *
    if re.search(r'SELECT\s+\*', sql, re.IGNORECASE):
        optimized = re.sub(
            r'SELECT\s+\*',
            'SELECT /* TODO: List specific columns */',
            optimized,
            flags=re.IGNORECASE
        )

    # Replace multiple ORs with IN
    # (simplified - real implementation would be more complex)

    return optimized


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "--analyze":
            if len(sys.argv) > 2:
                sql = " ".join(sys.argv[2:])
                print(generate_analysis_report(sql))
            else:
                # Read from stdin
                sql = sys.stdin.read()
                print(generate_analysis_report(sql))

        elif cmd == "--format":
            sql = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else sys.stdin.read()
            print(format_query(sql))

        elif cmd == "--explain":
            dialect = sys.argv[2] if len(sys.argv) > 2 else "mssql"
            sql = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else sys.stdin.read()
            print(generate_explain_plan(sql, dialect))

        elif cmd == "--patterns":
            print("SQL Anti-Patterns:\n" + "=" * 40)
            for name, pattern in SQL_ANTIPATTERNS.items():
                print(f"\n{name}")
                print(f"  Severity: {pattern['severity']}")
                print(f"  {pattern['description']}")
                print(f"  Fix: {pattern['fix']}")

        elif cmd == "--example":
            example_sql = """
            SELECT * FROM orders o
            JOIN customers c ON o.customer_id = c.id
            WHERE status = 'pending'
            OR status = 'processing'
            OR status = 'shipped'
            ORDER BY 1
            """
            print(generate_analysis_report(example_sql))
    else:
        print("SQL Analyzer")
        print("Usage:")
        print("  --analyze <sql>        Analyze query")
        print("  --format <sql>         Format query")
        print("  --explain <dialect>    Generate EXPLAIN")
        print("  --patterns             List anti-patterns")
        print("  --example              Show example analysis")
        print("")
        print("Example: python sql_analyzer.py --analyze \"SELECT * FROM users\"")
