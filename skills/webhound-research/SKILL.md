---
name: webhound-research
description: Run budget-controlled Webhound reports or datasets when a question deserves a real, inspectable investigation. Use for market maps, due diligence, source verification, evidence-backed comparisons, cited reports, or structured web datasets where missing information could change a decision.
license: MIT
---

# Webhound research

Use Webhound when the cost of missing information is greater than the cost of
doing more research. Use a quicker tool for simple factual lookups.

## Research contract

- The prompt says what to investigate. The dollar budget says how much effort
  the investigation deserves.
- Hound is Webhound's research harness built with DeepSeek V4 Pro and GPT-5.4
  across planning, execution, verification, and assembly.
- Hound is not a selectable model or mode, and it is not a direct pass-through
  to one provider.
- A larger budget should buy more searching, reading, comparison, verification,
  and evidence—not just a longer answer.
- Every user authorizes Webhound with their own account and API key. Never
  embed, share, or reuse a publisher's, teammate's, or other user's credential.

## Before starting

1. If the Webhound server needs authentication, ask the user to complete the
   client's Webhound OAuth flow. The authorization page accepts that user's own
   Webhound API key and exchanges it for a scoped MCP token.
2. Confirm the research question, desired artifact, and dollar budget. Starting
   a report, dataset, or budget extension can spend money, so do not invent or
   silently increase a budget.
3. Use a report for a cited argument, comparison, map, or recommendation. Use a
   dataset for rows, fields, and per-field provenance.
4. If the user wants guidance, suggest $2 for scouting, $5 for normal cited
   research, or $10 for deeper decision-driving work. Treat those as suggestions,
   not permission. Roughly, $1 buys about 15 minutes of research; this is a
   changing rule of thumb, not a guarantee.
5. A new account may have one indivisible free run for one exact $5 report or
   dataset. Check account or onboarding status rather than promising it.

Use `webhound_onboarding`, `webhound_account`, or `webhound_help` when setup or
account state is unclear.

## Run the investigation

1. Start with `webhound_start_report` or `webhound_start_dataset`.
2. Let Webhound work in the background. Do useful independent work instead of
   repeatedly polling.
3. Check progress with `webhound_watch` or `webhound_wait`. Follow
   `runtime_estimate.recommended_next_check_seconds` when the client can schedule
   a later check.
4. If you find a concrete source-backed lead while Webhound works, save it with
   `webhound_add_sidecar_notes`. Sidecar notes are leads, not a reason to
   interrupt the current planning, execution, or verification cycle.
5. Use `webhound_send_message` with `reason="awaiting_input"` when the run asks
   for information. Use `reason="user_guidance"` only when the user changes the
   objective, scope, constraints, or deliverable.
6. Do not lower the budget or ask Webhound to wrap up because partial notes look
   usable. Change the stopping boundary only when the user explicitly asks.
7. If a call returns `billing_required` or `credit_exhausted`, send the user to
   `https://www.webhound.ai/billing`, wait for them to act, then confirm account
   state before retrying the spend-bearing action.

## Finish honestly

- Treat `done=true` as the authoritative completion signal.
- `output_ready=true` can describe an intermediate artifact. Do not present the
  investigation as finished until `done=true`, unless the user explicitly asks
  for a partial update.
- Once complete, call `webhound_get_session` for the canonical session and
  `webhound_get_evidence_pack` when the answer depends on the research trail.
- Inspect the final output together with working documents, claims, sources,
  traces, limitations, and gaps. The report is an entry point into the work,
  not a substitute for the work.
- Use `webhound_get_output` for the polished result and
  `webhound_export_session` when the user needs a file.
- Create a public share link only when the user explicitly asks. Sharing changes
  the report or dataset from private to accessible by link.

When presenting the result, separate supported findings, uncertainty,
limitations, and useful next investigations. Never describe a run as resolving
to one backend model.
