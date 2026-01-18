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
import path from 'path';

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

  // === DOCUMENT SKILLS ===
  {
    name: 'docx',
    triggers: [
      /word\s*doc(ument)?/i,
      /\.docx/i,
      /create\s*(a\s*)?document/i,
      /edit\s*(the\s*)?document/i,
      /tracked\s*changes/i,
      /redline/i,
    ],
    description: 'Create, edit, and analyze Word documents'
  },
  {
    name: 'pdf',
    triggers: [
      /\bpdf\b/i,
      /merge\s*pdf/i,
      /split\s*pdf/i,
      /extract\s*(text\s*)?(from\s*)?pdf/i,
      /create\s*(a\s*)?pdf/i,
      /pdf\s*form/i,
    ],
    description: 'PDF creation, merging, splitting, and extraction'
  },
  {
    name: 'pptx',
    triggers: [
      /powerpoint/i,
      /\.pptx/i,
      /presentation/i,
      /\bslides?\b/i,
      /\bdeck\b/i,
      /create\s*(a\s*)?presentation/i,
    ],
    description: 'Create and edit PowerPoint presentations'
  },
  {
    name: 'xlsx',
    triggers: [
      /\bexcel\b/i,
      /spreadsheet/i,
      /\.xlsx/i,
      /financial\s*model/i,
      /\bformulas?\b/i,
      /pivot\s*table/i,
      /workbook/i,
    ],
    description: 'Excel spreadsheet creation and analysis'
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
  {
    name: 'web-artifacts',
    triggers: [
      /web\s*artifact/i,
      /single[\s-]?file\s*(app|html)/i,
      /bundle\s*(as\s*)?html/i,
      /standalone\s*app/i,
      /interactive\s*demo/i,
      /portable\s*(web\s*)?app/i,
    ],
    description: 'Self-contained HTML web applications'
  },
  {
    name: 'algorithmic-art',
    triggers: [
      /generative\s*art/i,
      /algorithmic\s*art/i,
      /p5\.?js/i,
      /creative\s*coding/i,
      /procedural\s*(generation|art)/i,
      /make\s*art\s*with\s*code/i,
    ],
    description: 'Generative art with p5.js'
  },

  // === TESTING ===
  {
    name: 'webapp-testing',
    triggers: [
      /playwright/i,
      /e2e\s*test/i,
      /end[\s-]?to[\s-]?end/i,
      /browser\s*automation/i,
      /ui\s*test/i,
      /test\s*(the\s*)?(webapp|frontend|ui)/i,
    ],
    description: 'Playwright browser automation and testing'
  },

  // === DEVELOPMENT TOOLS ===
  {
    name: 'mcp-builder',
    triggers: [
      /mcp\s*server/i,
      /mcp\s*tool/i,
      /build\s*(an?\s*)?mcp/i,
      /model\s*context\s*protocol/i,
      /extend\s*claude/i,
      /add\s*tools?\s*to\s*claude/i,
    ],
    description: 'Build MCP servers for Claude'
  },
  {
    name: 'skill-creator',
    triggers: [
      /create\s*(a\s*)?skill/i,
      /new\s*skill/i,
      /build\s*(a\s*)?skill/i,
      /skill\s*template/i,
      /skill\.md/i,
      /how\s*to\s*make\s*a\s*skill/i,
    ],
    description: 'Create new Claude Code skills'
  },
  {
    name: 'api-integration',
    triggers: [
      /integrate\s*(with\s*)?(api|service)/i,
      /api\s*(call|integration)/i,
      /webhook/i,
      /\brest\b/i,
      /graphql/i,
      /stripe/i,
      /fetch\s*from/i,
    ],
    description: 'External API integration patterns'
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

To load a skill, read the SKILL.md file from .claude/skills/{skill-name}/SKILL.md
</skill-activation>
`);
}

main();
