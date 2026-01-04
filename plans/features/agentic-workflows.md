# Agentic Workflows

> AI-powered automation with vault-based prompt and workflow management

---

## Overview

bwrb serves as a **harness** for AI agents, not an agent itself. It provides:

1. **Prompt/Agent storage** — Manage AI assets in the vault
2. **Workflow definitions** — Multi-step AI pipelines
3. **Execution engine** — Run workflows via OpenRouter API
4. **Cost tracking** — Monitor spending

```
┌─────────────────────────────────────────────────┐
│                  Obsidian Vault                 │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │  Prompts/  │  │  Workflows │  │  Results  │  │
│  │   Agents   │  │            │  │           │  │
│  └────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────┘
           │                │              ▲
           ▼                ▼              │
┌─────────────────────────────────────────────────┐
│                    bwrb                        │
│  • Reads workflow definitions                   │
│  • Manages execution state                      │
│  • Writes results back to vault                 │
│  • Tracks costs                                 │
└─────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────┐
│                  OpenRouter API                  │
│  • Claude, GPT-4, etc.                          │
│  • Actually executes prompts                    │
│  • Returns structured results                   │
└─────────────────────────────────────────────────┘
```

---

## Phase 1: Prompt & Agent Storage

### Prompt Type

Prompts are notes that define reusable AI instructions:

```yaml
---
type: prompt
model: claude-sonnet-4-20250514
temperature: 0.7
max-tokens: 2000
tags:
  - writing
  - summarization
---

# Summarize Content

You are a skilled summarizer. Given the following content, provide a concise summary that captures the key points.

## Guidelines

- Keep summaries under 200 words
- Use bullet points for multiple key points
- Preserve important details and nuances
- Maintain the original tone

## Content to Summarize

{input}
```

### Schema for Prompts

```json
{
  "types": {
    "prompt": {
      "output_dir": ".bwrb/prompts",
      "frontmatter": {
        "type": { "value": "prompt" },
        "model": {
          "prompt": "select",
          "enum": "models",
          "default": "claude-sonnet-4-20250514"
        },
        "temperature": {
          "prompt": "input",
          "default": "0.7"
        },
        "max-tokens": {
          "prompt": "input",
          "default": "2000"
        }
      }
    }
  },
  "enums": {
    "models": [
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku-20241022",
      "gpt-4o",
      "gpt-4o-mini"
    ]
  }
}
```

### Agent Type

Agents are notes that combine prompts with tools and configuration:

```yaml
---
type: agent
system-prompt: "[[.bwrb/prompts/Research Assistant]]"
tools:
  - web-search
  - summarize
  - extract-quotes
model: claude-sonnet-4-20250514
max-iterations: 5
---

# Research Agent

An agent that performs web research and synthesizes findings.

## Capabilities

- Search the web for information
- Summarize articles
- Extract relevant quotes
- Compile findings into structured notes

## Usage

Use this agent for research tasks that require multiple sources.
```

---

## Phase 2: Workflow Definitions

### Workflow Structure

Workflows are markdown notes that define multi-step AI pipelines:

```yaml
---
type: workflow
workflow-type: research
status: ready
inputs:
  - topic
  - depth
outputs:
  - summary
  - sources
max-cost: 0.50
---

# Research: {topic}

## Steps

1. **Search** → sources
   Prompt: [[.bwrb/prompts/Web Search]]
   Input: {topic}
   
2. **Summarize** → summaries
   Prompt: [[.bwrb/prompts/Summarize Content]]
   Input: {sources}
   For each: source in sources
   
3. **Synthesize** → summary
   Prompt: [[.bwrb/prompts/Synthesize Research]]
   Input: {summaries}

## Config

model: claude-sonnet-4-20250514
```

### Workflow Frontmatter

| Field | Description |
|-------|-------------|
| `type` | Must be `workflow` |
| `workflow-type` | Category (research, writing, analysis) |
| `status` | ready, running, completed, failed |
| `inputs` | Required input variables |
| `outputs` | Output variables produced |
| `max-cost` | Maximum spend limit |

---

## Phase 3: Workflow Execution

### Run Command

```bash
# Run workflow with inputs
bwrb run Workflows/research.md --topic "AI agents" --depth "comprehensive"

# Dry run (show what would execute)
bwrb run Workflows/research.md --topic "AI agents" --dry-run

# Check running workflows
bwrb run --status

# Cancel running workflow
bwrb run --cancel <workflow-id>
```

### Execution Flow

```bash
bwrb run Workflows/research.md --topic "AI agents"

# Starting workflow: Research: AI agents
# 
# Step 1/3: Search
#   Prompt: Web Search
#   Cost: $0.02
#   ✓ Completed (3 sources found)
# 
# Step 2/3: Summarize
#   Prompt: Summarize Content
#   Processing 3 sources...
#     Source 1: ✓ ($0.01)
#     Source 2: ✓ ($0.01)
#     Source 3: ✓ ($0.01)
#   ✓ Completed
# 
# Step 3/3: Synthesize
#   Prompt: Synthesize Research
#   Cost: $0.03
#   ✓ Completed
# 
# Workflow complete!
#   Total cost: $0.08
#   Output: Workflows/Results/Research - AI agents - 2025-01-15.md
```

### Result Output

Results are written back to the vault:

```yaml
---
type: workflow-result
workflow: "[[Workflows/research]]"
topic: "AI agents"
executed: 2025-01-15T14:30:00Z
total-cost: 0.08
status: completed
---

# Research Results: AI agents

## Summary

{synthesized summary}

## Sources

1. [Source 1 Title](url) - {summary}
2. [Source 2 Title](url) - {summary}
3. [Source 3 Title](url) - {summary}

## Execution Log

- Step 1 (Search): 3 sources, $0.02
- Step 2 (Summarize): 3 summaries, $0.03
- Step 3 (Synthesize): 1 synthesis, $0.03
```

---

## Phase 4: Cost Tracking

### Cost Storage

Costs are logged to `.bwrb/logs/costs.json`:

```json
{
  "entries": [
    {
      "timestamp": "2025-01-15T14:30:00Z",
      "workflow": "research",
      "model": "claude-sonnet-4-20250514",
      "input_tokens": 1500,
      "output_tokens": 800,
      "cost": 0.02
    }
  ],
  "totals": {
    "day": { "2025-01-15": 0.08 },
    "week": { "2025-W03": 0.45 },
    "month": { "2025-01": 2.30 },
    "workflow": { "research": 1.20, "writing": 0.80 }
  }
}
```

### Cost Commands

```bash
# View spending summary
bwrb costs

# Spending Summary
# 
# Today:      $0.08
# This week:  $0.45
# This month: $2.30
# 
# By workflow:
#   research: $1.20
#   writing:  $0.80
#   analysis: $0.30

# Filter by period
bwrb costs --period week
bwrb costs --period month
bwrb costs --period "2025-01"

# Filter by workflow
bwrb costs --workflow research

# Set budget alerts
bwrb costs --set-alert daily=5.00
bwrb costs --set-alert monthly=50.00
```

### Cost Limits

Workflows can specify max cost:

```yaml
---
type: workflow
max-cost: 0.50
---
```

```bash
bwrb run Workflows/expensive.md

# Step 3/5: Analysis
#   ⚠ Cost limit approaching: $0.45 / $0.50
#   Continue? [y/N]
```

---

## API Integration

### OpenRouter Configuration

Store API key securely:

```bash
bwrb config set openrouter-api-key <key>
# Stored in ~/.bwrb/config.json (not in vault)
```

Or via environment:

```bash
export OPENROUTER_API_KEY=<key>
```

### API Client

```typescript
interface OpenRouterRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function executePrompt(
  prompt: Prompt,
  input: string
): Promise<{ output: string; cost: number }> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: prompt.model,
      messages: [
        { role: 'system', content: prompt.content },
        { role: 'user', content: input },
      ],
      temperature: prompt.temperature,
      max_tokens: prompt.maxTokens,
    }),
  });
  
  const data = await response.json();
  const cost = calculateCost(prompt.model, data.usage);
  
  return {
    output: data.choices[0].message.content,
    cost,
  };
}
```

### Model Pricing

```typescript
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 }, // per million tokens
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

function calculateCost(
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number }
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  
  return (
    (usage.prompt_tokens / 1_000_000) * pricing.input +
    (usage.completion_tokens / 1_000_000) * pricing.output
  );
}
```

---

## Workflow Variables

### Input Variables

```yaml
inputs:
  - topic       # Required
  - depth?      # Optional (has ?)
  - sources: 5  # With default
```

### Step Variables

Steps can produce named outputs:

```yaml
1. **Search** → sources
   # 'sources' is now available for later steps
   
2. **Summarize** → summaries
   Input: {sources}
   # Uses 'sources' from step 1
```

### Iteration

Process lists with `for each`:

```yaml
2. **Summarize** → summaries
   For each: source in sources
   # Runs once per source, collects into 'summaries'
```

### Conditionals

```yaml
3. **Deep Analysis** → analysis
   If: depth == "comprehensive"
   # Only runs if condition is true
```

---

## Error Handling

### Step Failure

```bash
bwrb run Workflows/research.md --topic "AI agents"

# Step 2/3: Summarize
#   ✗ Failed: API error (rate limit)
#   
# Options:
#   1. Retry step
#   2. Skip step
#   3. Abort workflow
# > 1
# 
# Retrying...
#   ✓ Completed
```

### Cost Overrun

```bash
bwrb run Workflows/expensive.md

# Step 4/5: Analysis
#   ✗ Cost limit exceeded: $0.52 > $0.50
#   
# Workflow paused. Options:
#   1. Increase limit and continue
#   2. Abort workflow
# > 1
# 
# New limit: 1.00
# Continuing...
```

### Partial Results

Failed workflows save partial results:

```yaml
---
type: workflow-result
status: partial
completed-steps: 2
failed-step: 3
error: "API rate limit exceeded"
---

# Research Results: AI agents (Partial)

## Completed

Step 1: Search - ✓
Step 2: Summarize - ✓

## Failed

Step 3: Synthesize - Rate limit exceeded

## Partial Results

{whatever was completed}
```

---

## CLI Reference

```bash
# Prompts
bwrb new prompt                     # Create prompt
bwrb list prompt                    # List prompts
bwrb run-prompt <prompt> --input "text"  # Test prompt

# Agents
bwrb new agent                      # Create agent
bwrb list agent                     # List agents

# Workflows
bwrb new workflow                   # Create workflow
bwrb list workflow                  # List workflows
bwrb run <workflow> [--inputs]      # Execute workflow
bwrb run --status                   # Show running workflows
bwrb run --cancel <id>              # Cancel workflow
bwrb run --dry-run                  # Preview execution

# Costs
bwrb costs                          # Spending summary
bwrb costs --period <period>        # Filter by time
bwrb costs --workflow <name>        # Filter by workflow
bwrb costs --set-alert <limit>      # Set budget alert

# Config
bwrb config set openrouter-api-key <key>
bwrb config get openrouter-api-key
```

---

## Future Considerations

### Tool Integration

Agents could use tools beyond prompts:

```yaml
tools:
  - web-search      # Search the web
  - read-file       # Read vault files
  - write-file      # Write to vault
  - run-command     # Execute shell commands
```

### Scheduling

Automatic workflow execution:

```yaml
schedule: "0 9 * * 1"  # Every Monday at 9am
```

```bash
bwrb schedule list
bwrb schedule enable <workflow>
bwrb schedule disable <workflow>
```

### Streaming

Real-time output during execution:

```bash
bwrb run Workflows/writing.md --stream
# Shows output as it's generated
```

---

## Success Criteria

1. **Vault-native** — All assets stored as notes
2. **Cost-aware** — Clear tracking and limits
3. **Resumable** — Handle failures gracefully
4. **Composable** — Reusable prompts and workflows
5. **Observable** — Clear execution logs
