---
name: "webhound"
displayName: "Webhound Research"
description: "Run budget-controlled, inspectable reports and datasets with Hound, Webhound's research harness built with DeepSeek V4 Pro and GPT-5.4 across planning, execution, verification, and assembly."
keywords: ["webhound", "research", "web research", "market research", "due diligence", "source verification", "cited report", "dataset extraction", "evidence pack"]
author: "Webhound"
---

# Webhound Research

Use Webhound when a question deserves more than the first plausible answer.
The prompt says what to investigate. The dollar budget says how much effort the
investigation deserves.

Hound is Webhound's research harness built with DeepSeek V4 Pro and GPT-5.4
across planning, execution, verification, and assembly. It is not a selectable
model or mode, and it is not a direct pass-through to one provider.

## Onboarding

1. Confirm that the `webhound` MCP server is connected.
2. If authentication is required, let Kiro open Webhound sign-in and consent.
   Every user connects with their own Webhound account. Never request, embed,
   share, or reuse a publisher's or another user's credential.
3. Use `webhound_onboarding`, `webhound_account`, or `webhound_help` to check
   setup, free-run eligibility, defaults, and billing state.
4. Before any spend-bearing call, confirm the research question, output type,
   and dollar budget with the user.

The bundled MCP configuration intentionally contains no credential. Webhound's
OAuth flow uses the connecting user's Webhound sign-in and consent to issue a
scoped MCP token for that account.

## Choose the work product

- Use a report for a cited argument, comparison, market map, recommendation, or
  decision memo.
- Use a dataset for rows, fields, and per-field provenance.
- Recommend $2 for quick scouting, $5 for normal cited research, $10 for deep
  work, or $20 for exhaustive/highest-stakes work only when the user asks for
  budget guidance. These are starting points, not caps or permission to spend;
  the user can choose a larger custom budget for longer, deeper research.
- Roughly, $1 buys about 15 minutes, so $5 is about 75 minutes and $20 is about
  300 minutes (five hours). Actual runtime still varies.

## Start and monitor

1. Start with `webhound_start_report` or `webhound_start_dataset`.
2. Let the run continue in the background. Do useful independent work rather
   than polling continuously.
3. Check progress with `webhound_watch` or `webhound_wait`, using
   `runtime_estimate.recommended_next_check_seconds` when available.
4. Add concrete, source-backed leads with `webhound_add_sidecar_notes`. Notes
   support the investigation without interrupting its current cycle.
5. Send `reason="awaiting_input"` only when the run asks for information. Send
   `reason="user_guidance"` only when the user changes the objective, scope,
   constraints, or deliverable.
6. Never lower the budget or ask Webhound to wrap up merely because partial
   notes look usable.
7. For `billing_required` or `credit_exhausted`, send the user to
   `https://www.webhound.ai/billing`, wait for them to act, then verify account
   state before retrying.

## Retrieve the finished investigation

- `done=true` is the authoritative terminal signal.
- `output_ready=true` may describe an intermediate artifact. Keep waiting
  unless the user explicitly asks for a partial update.
- Once `done=true`, use `webhound_get_session` for the canonical session and
  `webhound_get_evidence_pack` when the answer depends on the research trail.
- Inspect working documents, claims, sources, traces, uncertainty, limitations,
  and remaining gaps along with the polished output.
- Use `webhound_get_output` for the final report and
  `webhound_export_session` when the user needs a file.
- Make a report or dataset public by link only when the user explicitly asks.

Present findings with calibrated claims and visible limitations. Never say
Hound resolves to one backend model.

## License and support

This power is licensed under [MIT](./LICENSE).

This power integrates with [Webhound MCP](https://github.com/WebhoundAI/webhound-mcp)
(MIT).

- [Privacy Policy](https://www.webhound.ai/privacy)
- [Support](https://github.com/WebhoundAI/webhound-mcp/issues)
- Support email: [moe@webhound.ai](mailto:moe@webhound.ai)
