import { strict as assert } from 'assert';
import {
  clearPIITokenizerForSession,
  DataFlowManager,
  getPIITokenizerForSession,
  PIITokenizer,
} from '../code-execution/pii-tokenizer.js';

let failures = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`• ${name}... `);
  try {
    await fn();
    console.log('ok');
  } catch (error) {
    failures++;
    console.log('FAILED');
    console.error(error);
  }
}

async function main(): Promise<void> {
  console.log('Running PII tokenizer tests...\n');

  await runTest('PII-001: text tokenization redacts email and phone values', () => {
    const tokenizer = new PIITokenizer();
    const result = tokenizer.tokenize('Contact ada@example.com or 415-555-0134.');

    assert.equal(result.piiDetected, true);
    assert.match(result.text, /\[EMAIL_1]/);
    assert.match(result.text, /\[PHONE_1]/);
    assert.equal(result.text.includes('ada@example.com'), false);
    assert.equal(result.text.includes('415-555-0134'), false);
    assert.deepEqual(result.tokens.map(t => t.type).sort(), ['EMAIL', 'PHONE']);
  });

  await runTest('PII-002: repeated values reuse stable tokens and detokenize recursively', () => {
    const tokenizer = new PIITokenizer();
    const first = tokenizer.tokenize('ada@example.com');
    const second = tokenizer.tokenize('email ada@example.com again');
    const object = tokenizer.tokenizeObject({
      owner: 'ada@example.com',
      nested: ['call 415-555-0134'],
    });

    assert.equal(first.text, '[EMAIL_1]');
    assert.equal(second.text, 'email [EMAIL_1] again');
    assert.deepEqual(tokenizer.detokenizeObject(object.result), {
      owner: 'ada@example.com',
      nested: ['call 415-555-0134'],
    });
  });

  await runTest('PII-003: data-flow rules block or tokenize PII before target tools', () => {
    const tokenizer = new PIITokenizer();
    const manager = new DataFlowManager(tokenizer);
    manager.addRule({
      sourceTools: ['crm_read'],
      targetTools: ['model_context'],
      allowedDataTypes: [],
      blockPII: true,
    });

    assert.equal(manager.canFlow('crm_read', 'model_context', 'ada@example.com'), false);
    assert.deepEqual(manager.processDataFlow('crm_read', 'model_context', {
      email: 'ada@example.com',
    }), {
      email: '[EMAIL_1]',
    });
  });

  await runTest('PII-004: session tokenizer lifecycle is isolated and clearable', () => {
    const first = getPIITokenizerForSession('session-a');
    const second = getPIITokenizerForSession('session-a');
    const other = getPIITokenizerForSession('session-b');

    assert.ok(first);
    assert.equal(first, second);
    assert.notEqual(first, other);
    clearPIITokenizerForSession('session-a');
    assert.notEqual(getPIITokenizerForSession('session-a'), first);
    clearPIITokenizerForSession('session-b');
  });

  console.log(`\nPII tokenizer tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
