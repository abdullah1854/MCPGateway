#!/usr/bin/env node
/**
 * Skill Activation Hook
 *
 * Runs on UserPromptSubmit to analyze the user's prompt and
 * recommend relevant skills for Claude to load.
 *
 * This ensures skills auto-activate based on context.
 */

import fs from 'fs';

// Skill definitions with trigger keywords/patterns
const SKILLS = [
  // === THINKING & ANALYSIS ===
  {
    name: 'deep-thinking',
    triggers: [
      /think\s*(harder|deeply|step by step)/i,
      /ultrathink/i,
      /analyze\s*thoroughly/i,
      /complex\s*(problem|decision|issue)/i,
      /architecture\s*decision/i,
      /trade-?off/i,
      /design\s*system/i,
    ],
    description: 'Extended reasoning for complex problems'
  },

  // === CODE QUALITY ===
  {
    name: 'code-review',
    triggers: [
      /review\s*(this\s*)?(code|pr|pull\s*request)/i,
      /check\s*(this\s*)?(code|for\s*bugs)/i,
      /security\s*(audit|review|check)/i,
      /find\s*(bugs|issues|vulnerabilities)/i,
      /code\s*quality/i,
    ],
    description: 'Security, performance, and maintainability review'
  },
  {
    name: 'debugging',
    triggers: [
      /debug/i,
      /fix\s*(this\s*)?(bug|error|issue)/i,
      /not\s*working/i,
      /\b(undefined|null|crash|fails|broken)\b/i,
      /error\s*message/i,
      /stack\s*trace/i,
    ],
    description: 'Systematic debugging protocol'
  },
  {
    name: 'test-driven-fix',
    triggers: [
      /write\s*a\s*test\s*first/i,
      /test[\s-]*driven\s*fix/i,
      /tdd\s*fix/i,
      /reproduce\s*with\s*test/i,
      /make\s*it\s*pass/i,
    ],
    description: 'Test-first debugging loop'
  },
  {
    name: 'sql-analyzer',
    triggers: [
      /sql\s*(anti[\s-]*pattern|optimi[sz])/i,
      /slow\s*query/i,
      /query\s*performance/i,
      /explain\s*plan/i,
    ],
    description: 'SQL query anti-patterns and optimization'
  },

  // === GIT & VERSION CONTROL ===
  {
    name: 'git-workflow',
    triggers: [
      /\b(commit|push|merge|rebase)\b/i,
      /create\s*(a\s*)?(pr|pull\s*request)/i,
      /git\s/i,
      /branch/i,
      /resolve\s*conflict/i,
    ],
    description: 'Git operations and conventional commits'
  },
  {
    name: 'daily-standup',
    triggers: [
      /standup/i,
      /daily\s*report/i,
      /what\s*did\s*(i|we)\s*(do|work)/i,
      /yesterday['']?s?\s*work/i,
    ],
    description: 'Git-based standup reports'
  },
  {
    name: 'pr-summary',
    triggers: [
      /pr\s*summary/i,
      /pull\s*request\s*(summary|description)/i,
      /describe\s*(this\s*)?pr/i,
    ],
    description: 'Pull request descriptions'
  },

  // === FRONTEND & UI ===
  {
    name: 'frontend-build',
    triggers: [
      /build\s*(a\s*)?(ui|component|page)/i,
      /landing\s*page/i,
      /dashboard/i,
      /frontend/i,
      /tailwind/i,
      /responsive/i,
      /design\s*(this|a)/i,
      /\breact\b/i,
      /next\.?js/i,
      /shadcn/i,
    ],
    description: 'Production-grade frontend with distinctive design'
  },

  // === DOCUMENTATION ===
  {
    name: 'doc-coauthoring',
    triggers: [
      /write\s*(a\s*)?(document|doc|proposal|spec)/i,
      /draft\s*(a\s*)?(proposal|spec|rfc)/i,
      /co[\s-]?author/i,
      /help\s*me\s*write/i,
      /\brfc\b/i,
      /\badr\b/i,
      /design\s*doc/i,
      /technical\s*spec/i,
    ],
    description: 'Collaborative document writing workflow'
  },

  // === INFRASTRUCTURE ===
  {
    name: 'infra-deploy',
    triggers: [
      /deploy/i,
      /vps/i,
      /docker/i,
      /coolify/i,
      /\bssh\b/i,
      /nginx/i,
      /production/i,
      /server\s*setup/i,
      /hosting/i,
    ],
    description: 'Infrastructure and deployment'
  },
  {
    name: 'hostinger-deploy',
    triggers: [
      /hostinger/i,
      /hpanel/i,
      /opcache/i,
    ],
    description: 'Hostinger-specific deployment'
  },
  {
    name: 'seo-recovery',
    triggers: [
      /\bseo\b/i,
      /traffic\s*drop/i,
      /indexing/i,
      /canonical/i,
      /hreflang/i,
      /sitemap/i,
      /search\s*console/i,
      /\bgsc\b/i,
      /crawl\s*errors/i,
      /deindexed/i,
      /organic\s*traffic/i,
    ],
    description: 'SEO diagnostic protocol'
  },

  // === SESSION MANAGEMENT ===
  {
    name: 'session-handoff',
    triggers: [
      /save\s*(this\s*)?session/i,
      /handoff/i,
      /continue\s*later/i,
      /switching\s*ide/i,
      /end\s*(of\s*)?session/i,
      /summarize\s*(what\s*we|session)/i,
      /wrap(ping)?\s*up/i,
    ],
    description: 'Context preservation across sessions'
  },

  // === DOMAIN-SPECIFIC: ERP ===
  {
    name: 'd365fo-debugging',
    triggers: [
      /d365/i,
      /dynamics\s*(365|ax)/i,
      /\bax\b/i,
      /voucher/i,
      /dataareaid/i,
      /\bssrs\b/i,
      /batch\s*job/i,
      /posting/i,
      /(invoice|transaction)\s*(not\s*)?(showing|missing)/i,
      /\bdmf\b/i,
      /data\s*management/i,
      /\bwms\b/i,
      /warehouse/i,
      /work\s*(order|id)\s*(stuck|not)/i,
      /wave/i,
      /can't\s*(post|see|access)/i,
      /user\s*can't/i,
      /security\s*(role|privilege)/i,
      /slow\s*(query|report|batch)/i,
      /blocking|deadlock/i,
      /sales\s*order/i,
      /purchase\s*order/i,
      /\bpo\b|\bso\b/i,
      /missing\s*(lines|records|from\s*report)/i,
      /wrong\s*(amount|calculation)/i,
      /integration.*success.*no\s*record/i,
    ],
    description: 'Complete D365 F&O debugging framework'
  },
  {
    name: 'maximo-helper',
    triggers: [
      /maximo/i,
      /work\s*order/i,
      /\bwonum\b/i,
      /\basset(num)?\b/i,
      /labtrans/i,
      /siteid/i,
      /\bgbe\b/i,
    ],
    description: 'Maximo database queries with site filtering'
  },
  {
    name: 'gbcr-commission',
    triggers: [
      /gbcr/i,
      /commission/i,
      /agreement\s*(no|number)?/i,
      /settlement/i,
      /ftcnv/i,
      /rebate/i,
      /vendor\s*commission/i,
    ],
    description: 'GBCR commission debugging'
  },
  {
    name: 'debug-rental-commission',
    triggers: [
      /rental\s*commission/i,
      /commission\s*pipeline/i,
    ],
    description: 'Rental commission pipeline debugging'
  },
  {
    name: 'office-skill',
    triggers: [
      /crm\s*pipeline/i,
      /maximo\s*sync/i,
    ],
    description: 'CRM pipeline and Maximo sync operations'
  },
];

// Get user prompt from stdin (Claude Code passes it via environment or stdin)
function getUserPrompt() {
  // Try environment variable first
  if (process.env.CLAUDE_USER_PROMPT) {
    return process.env.CLAUDE_USER_PROMPT;
  }

  // Try reading from stdin if available
  try {
    const stdinBuffer = fs.readFileSync(0, 'utf-8');
    if (stdinBuffer) {
      const data = JSON.parse(stdinBuffer);
      return data.prompt || data.message || stdinBuffer;
    }
  } catch (e) {
    // No stdin available
  }

  return '';
}

// Find matching skills
function findMatchingSkills(prompt) {
  const matches = [];

  for (const skill of SKILLS) {
    for (const trigger of skill.triggers) {
      if (trigger.test(prompt)) {
        matches.push(skill);
        break; // Only match each skill once
      }
    }
  }

  return matches;
}

// Main execution
function main() {
  const prompt = getUserPrompt();

  if (!prompt) {
    // No prompt to analyze, exit silently
    process.exit(0);
  }

  const matchedSkills = findMatchingSkills(prompt);

  if (matchedSkills.length === 0) {
    // No skills matched, exit silently
    process.exit(0);
  }

  // Output skill recommendations that will be injected into context
  const skillList = matchedSkills
    .map(s => `- **${s.name}**: ${s.description}`)
    .join('\n');

  console.log(`
<skill-activation>
## Relevant Skills Detected

The following skills are relevant to this request. Load them for best results:

${skillList}

To load a skill, read the SKILL.md file from .agents/skills/{skill-name}/SKILL.md
</skill-activation>
`);
}

main();
