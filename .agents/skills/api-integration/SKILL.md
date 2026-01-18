---
name: api-integration
description: External API integration patterns for REST, GraphQL, webhooks. Activates for "integrate API", "call API", "webhook", "REST", "GraphQL", "fetch", "axios", "HTTP" requests.
allowed-tools: [Read, Write, Edit, Bash, Grep, WebFetch]
---

# API Integration Protocol

## When This Skill Activates
- "Integrate with [API name]", "call this API"
- "Setup webhook", "receive webhook"
- "REST API", "GraphQL"
- "Fetch data from", "POST to"
- Any external service integration

## API Client Setup

### TypeScript HTTP Client (Recommended)
```typescript
// lib/api-client.ts
interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

interface ApiResponse<T> {
  data: T;
  status: number;
}

interface ApiError {
  message: string;
  status: number;
  code?: string;
}

export function createApiClient(config: ApiConfig) {
  const { baseUrl, apiKey, timeout = 30000 } = config;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw {
          message: error.message || `HTTP ${response.status}`,
          status: response.status,
          code: error.code,
        } as ApiError;
      }

      const data = await response.json();
      return { data, status: response.status };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw { message: 'Request timeout', status: 408, code: 'TIMEOUT' };
      }
      throw error;
    }
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    delete: <T>(path: string) => request<T>('DELETE', path),
  };
}

// Usage
const stripe = createApiClient({
  baseUrl: 'https://api.stripe.com/v1',
  apiKey: process.env.STRIPE_SECRET_KEY,
});

const { data } = await stripe.get<Customer>('/customers/cus_xxx');
```

## Common Integration Patterns

### Stripe Integration
```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

// Create checkout session
export async function createCheckout(priceId: string, userId: string) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/canceled`,
    client_reference_id: userId,
    metadata: { userId },
  });
}

// Webhook handler
export async function handleWebhook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      await activateSubscription(session.client_reference_id!);
      break;
    case 'customer.subscription.deleted':
      const subscription = event.data.object;
      await deactivateSubscription(subscription.metadata.userId);
      break;
  }
}
```

### OpenAI Integration
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateCompletion(prompt: string) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
    temperature: 0.7,
  });

  return response.choices[0].message.content;
}

// Streaming
export async function* streamCompletion(prompt: string) {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });

  for await (const chunk of stream) {
    yield chunk.choices[0]?.delta?.content || '';
  }
}
```

### Database API (Supabase)
```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// CRUD operations
export const db = {
  async getUser(id: string) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  async createUser(user: { email: string; name: string }) {
    const { data, error } = await supabase
      .from('users')
      .insert(user)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async updateUser(id: string, updates: Partial<User>) {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};
```

## Webhook Handling

### Secure Webhook Endpoint (Next.js)
```typescript
// app/api/webhooks/[provider]/route.ts
import { headers } from 'next/headers';
import crypto from 'crypto';

export async function POST(
  req: Request,
  { params }: { params: { provider: string } }
) {
  const body = await req.text();
  const headersList = headers();

  // Verify signature based on provider
  const isValid = verifyWebhook(params.provider, body, headersList);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);

  // Process webhook
  try {
    await processWebhook(params.provider, payload);
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return new Response('Processing error', { status: 500 });
  }
}

function verifyWebhook(provider: string, body: string, headers: Headers): boolean {
  switch (provider) {
    case 'stripe':
      return verifyStripeSignature(body, headers.get('stripe-signature')!);
    case 'github':
      return verifyGithubSignature(body, headers.get('x-hub-signature-256')!);
    default:
      return false;
  }
}

function verifyStripeSignature(body: string, signature: string): boolean {
  // Use Stripe SDK for verification
  try {
    stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
    return true;
  } catch {
    return false;
  }
}

function verifyGithubSignature(body: string, signature: string): boolean {
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!);
  const digest = 'sha256=' + hmac.update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}
```

## Error Handling & Retry

### Retry with Exponential Backoff
```typescript
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = error.status >= 500 || error.code === 'TIMEOUT';

      if (isLastAttempt || !isRetryable) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Max retries exceeded');
}
```

## Rate Limiting

### Client-Side Rate Limiter
```typescript
class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private maxConcurrent: number,
    private minDelay: number
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }

    this.running++;
    try {
      const result = await fn();
      await new Promise(resolve => setTimeout(resolve, this.minDelay));
      return result;
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Usage: 5 concurrent requests, 100ms between each
const limiter = new RateLimiter(5, 100);
const results = await Promise.all(
  urls.map(url => limiter.execute(() => fetch(url)))
);
```

## Environment Variables Checklist
```bash
# .env.example
# API Keys
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
OPENAI_API_KEY=sk-xxx

# Database
DATABASE_URL=postgres://...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=xxx

# App
APP_URL=http://localhost:3000
```

## Security Checklist
- [ ] API keys in environment variables, never in code
- [ ] Webhook signatures verified
- [ ] HTTPS only in production
- [ ] Rate limiting implemented
- [ ] Error messages don't leak sensitive info
- [ ] Timeouts configured
- [ ] Input validation on all endpoints
