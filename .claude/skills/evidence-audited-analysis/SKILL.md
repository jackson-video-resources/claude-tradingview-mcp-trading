---
name: evidence-audited-analysis
description: Data-skepticism discipline for quantitative work. Use whenever reading data and producing a conclusion: analytics questions, metrics reports, spreadsheet analysis, SQL queries, dashboards, A/B results, forecasts, or any claim of the form "the data shows." Trigger before presenting any number or trend to a user.
---

# Evidence-Audited Analysis

The most common analytical failure is not a wrong model. It is a confident, well-written narrative built on numbers nobody interrogated. Audit the evidence before you analyze it, and state what it cannot show alongside what it can.

## Interrogate the data first

Before any analysis, profile what you were given and report anomalies:

1. **Shape:** row counts, date coverage, obvious gaps. An analysis of "last quarter" on a table that only starts mid-quarter is wrong before it begins.
2. **Quality:** nulls, duplicates, impossible values (negative durations, future timestamps), unit surprises (cents vs dollars, UTC vs local).
3. **Meaning:** for every field you lean on, answer in writing: *what does this number actually measure, and who put it there?* A "deal created" count measures logging behavior, not demand. A "page view" count includes bots unless someone excluded them. If a human process feeds the field, the field inherits that process's habits, and you must ask about them before treating the field as ground truth.

If a profiling step surfaces something odd, resolve it or disclose it. Never silently analyze around it.

## Audit your own numbers

1. **Reproduce every headline number a second, independent way** before reporting it: a different query, a different aggregation path, or a manual spot-check of raw rows. If two routes disagree, that is a finding about the data, and it comes before any other finding.
2. **Baseline before model.** Report the naive answer (last period's value, the overall average, the simplest split) before anything sophisticated. If the sophisticated answer does not beat the baseline meaningfully, say so; the baseline is the finding.
3. **Small samples get small claims.** State the n behind every rate or comparison. "Conversion doubled" on 4 versus 2 events is noise wearing a trend's clothes. When the sample cannot support the conclusion, the honest deliverable is "this data cannot answer that yet," with what would be needed.

## Gate the language

1. **Correlation stays correlational** until you can name a mechanism and have considered at least one alternative explanation (seasonality, mix shift, a tracking change, a policy change). Only then may "because" appear.
2. **Every deliverable includes a "what this cannot tell you" section:** the questions the data looks like it answers but does not, the populations it excludes, the biases in how it was collected.
3. **Uncertainty is part of the number.** Ranges, caveats, and confidence live next to the figure they qualify, not in a footnote after the reader has already anchored.

## Why this matters

Downstream decisions inherit upstream credulity. A skipped "what does this field actually measure" step does not fail loudly; it produces a plausible chart, a confident recommendation, and a wrong decision weeks later. The discipline is cheap: minutes of profiling and one independent recomputation, purchased against conclusions that are expensive precisely because they are believed.
