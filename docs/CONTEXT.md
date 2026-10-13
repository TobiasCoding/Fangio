# Contextual analysis: how Fangio suggests groups

This document summarizes the prior research, the alternatives evaluated and the design
implemented in the **Temas** (Topics) view (v1.1). The code is in `src/core/context/` (pure
engine, no `chrome.*`), `src/ui/dashboard/context.ts` (input from records and preferences)
and `src/ui/dashboard/localAi.ts` (optional local AI).

## The problem

Given hundreds or thousands of references (URL, title, dates), propose groups that
correspond to **a single task or topic**, even across sites: a Google search, a ChatGPT
conversation about the same thing and then two or three sites read in the following
minutes. Fangio's constraints:

- **Nothing leaves the computer** (no servers or cloud APIs).
- **No host permissions to read pages**: only title, URL and dates are available, not the
  content.
- It must work with 10,000 references without freezing the panel.

## Prior work

| Work | Relevant idea | What we took |
|---|---|---|
| Jones and Klinkner, *Beyond the session timeout* (CIKM 2008) | Segment search queries into tasks by combining lexical and temporal features; a time cutoff alone is not enough. | Lexical similarity **modulated** by time, not replaced by it. |
| Lucchese et al., *Identifying task-based sessions in search engine query logs* (WSDM 2011) | Tasks interleave (about 75 % of queries happen while multitasking); clustering with lexical distance plus time between queries. | Pair graph with lexical weight times a temporal kernel; groups that are not contiguous in time. |
| Chang et al., *When the Tab Comes Due* (CHI 2021) and *Tabs.do* (UIST 2021) | Tabs naturally cluster by task; suggestions from behavioral and semantic signals. | Behavioral signals: opener tab (followed link), Chrome tab group, project. |
| Blondel et al., *Fast unfolding of communities in large networks* (2008) | Louvain algorithm: maximizes modularity, fast on sparse graphs. | Partitioning of the affinity graph. |
| Grootendorst, *BERTopic* (2022) | c-TF-IDF: terms that distinguish a class from the rest. | Group names. |
| Mozilla, *How Firefox suggests tab groups with local AI* (2025) | Local MiniLM embeddings and logistic regression to suggest tabs; distilled T5 (57 MB) for naming, fed with c-TF-IDF keywords. They name **time** as future work. | Validated the c-TF-IDF approach and confirmed that the temporal component is the differentiating contribution. |
| Hisatomi (Kyoto Univ.), UIST 2025 poster | Community detection on the graph of transitions between tabs, without training. | Reinforces graph and communities instead of trained classifiers. |
| Yan et al., *Biterm Topic Model* (WWW 2013); Yin and Wang, *GSDMM* (KDD 2014) | Topic models for short texts. | Evaluated and discarded: they require fixing the number of topics, iterate by sampling and don't use time. |

## Alternatives evaluated

| Option | Advantages | Costs | Decision |
|---|---|---|---|
| **Algorithmic** (TF-IDF, time, structure, Louvain, c-TF-IDF) | 0 bytes of model, deterministic, explainable ("in common: hooks ×4"), 10,000 references in about 0.2 s, multilingual without training. | Doesn't understand synonyms or translations ("coche" and "auto"). | **Implemented** (always on). |
| **Chrome built-in AI** (Gemini Nano, Prompt API, on device) | Zero bytes in the extension; Chrome manages the model; no new permissions; understands the meaning of titles. | Requires compatible hardware and a one-time download of several GB made by Chrome; not available on every computer. No embeddings API. | **Optional**: names groups and flags titles that don't belong. |
| Local embeddings (MiniLM with Transformers.js or ONNX) | Real semantic similarity (synonyms, languages). | From 23 MB (English) to about 120 MB (multilingual) per model, `wasm-unsafe-eval` in the CSP, downloading or bundling the model, CPU on modest computers (Firefox got complaints about resource usage with its version). | **Not implemented** for now; the engine can add a semantic signal later. |
| Topic models for short texts (BTM, GSDMM) | Well studied. | Fixed number of topics, non-deterministic, no temporal component. | Discarded. |

## Implemented design

### 1. Per-reference features (`text.ts`)

- **Clean title**: counters are removed ("(3) Bandeja…") and the title is split into
  segments on separators (` - `, ` | `, ` · `…).
- **Per-site noise, learned from the data**: a segment that appears in at least 50 % (and 3
  or more) of the titles of the same domain ("Stack Overflow", "Mercado Libre") is
  discarded. The site name (domain labels: `react.dev` gives "react") is kept with weight
  0.3 and never names a group.
- **What you searched for**: the query is extracted from the URL of Google, Bing,
  DuckDuckGo, Yahoo, Ecosia, Brave, YouTube, Amazon, Mercado Libre, GitHub, Stack Overflow
  and Wikipedia (weight 1.3: it is the most explicit intent).
- **URL words** (`/how-to-use-react-hooks`), weight 0.4, without ids or hashes.
- Lowercased, accent-free tokens, without stop words (es/en/pt), with conservative stemming
  shared by the three languages (plurals, `-iones`, `-ies`, English gerund, `reactjs` as
  `react`) and **bigrams of adjacent words only** ("rodado 29").
- **Site type**: search, AI chat (ChatGPT, Claude, Gemini, Perplexity, Copilot…), video or
  site.

### 2. Affinity graph (`engine.ts`)

TF-IDF per reference (terms found in a single reference weigh half: they connect nothing)
and candidate pairs from an inverted index (only references that share some term are
compared; posting lists longer than 400 are ignored as uninformative). Weight of a pair:

    w = lexical · (0.45 + 0.55 · T) + 0.35 · opener + 0.25 · same Chrome group + 0.20 · same project
    T = 0.65 · e^(−Δ / 45 min) + 0.35 · e^(−Δ / 3 days)

`Δ` is the minimum distance between instants of **real activity** (opening, last access).
Bulk dates (initial snapshot on install, batch archiving or reopening) are excluded because
they would fake coincidences. Without shared words, only the opener tab, the Chrome group or
the project link references: **time alone never groups**. Weights below 0.1 are discarded
and the 12 strongest neighbors of each reference are kept.

### 3. Communities and names

- Deterministic **Louvain** (same result for the same input). Communities larger than 50
  are split again with a higher resolution. Those smaller than 3 are discarded, unless a
  loose reference has at least 60 % of its weight (and 0.25 or more) toward a group: then it
  joins it.
- **Name** by c-TF-IDF: terms present in at least 25 % of the group and rare in the rest; up
  to 3 non-overlapping ones are chosen, with the most frequent written form (preferring
  capitalized: "React" over "react").
- **Affinity** (0 to 1): 50 % conductance (internal weight versus outgoing links), 30 %
  mean internal weight, 20 % density.
- **Path**: members in chronological order with their type (search, AI, video, site).
- Suggestion order: affinity × size × recency (14-day half-life).

### 4. Optional local AI (`localAi.ts`)

If `LanguageModel` exists and the computer qualifies, the **Nombrar con IA local** (Name
with local AI) button sends Gemini Nano, on the device, the keywords and up to 10 titles of
each group, with the output constrained by a JSON Schema (`name`, `outliers`). The returned
indexes are validated and the AI can never "remove" more than half of a group. If Chrome
hasn't downloaded the model yet, explicit confirmation is requested before starting the
download.

## Results

- Unit tests (`tests/context.test.ts`): search, ChatGPT and 3 sites grouped without noise;
  site noise learned (two topics on Stack Overflow don't mix); time alone doesn't group; a
  chain of opener tabs with no shared words does; determinism; 10,000 references in about
  0.2 s with pure groups.
- E2E in real Chromium (`npm run test:e2e:views`): see
  [TESTING.md](TESTING.md#views-and-contextual-analysis-v11).

## Limitations

- No page content: two titles with no shared words are only joined by structure (opener
  tab, group, project).
- Synonyms and translations are not recognized without a semantic layer.
- After restarting the browser, "last accessed" may reflect the session restore.
- The view's preferences (dismissed suggestions, names) live in this browser
  (`localStorage`), not in the database or in backups.

## References

- R. Jones, K. L. Klinkner. *Beyond the session timeout: automatic hierarchical segmentation of search topics in query logs*. CIKM 2008.
- C. Lucchese, S. Orlando, R. Perego, F. Silvestri, G. Tolomei. *Identifying task-based sessions in search engine query logs*. WSDM 2011. https://doi.org/10.1145/1935826.1935875
- J. C. Chang, N. Hahn, Y. Kim et al. *When the Tab Comes Due: Challenges in the Cost Structure of Browser Tab Usage*. CHI 2021.
- J. C. Chang, Y. Kim, V. Miller, M. X. Liu, B. A. Myers, A. Kittur. *Tabs.do: Task-Centric Browser Tab Management*. UIST 2021.
- V. D. Blondel, J.-L. Guillaume, R. Lambiotte, E. Lefebvre. *Fast unfolding of communities in large networks*. J. Stat. Mech. 2008.
- M. Grootendorst. *BERTopic: Neural topic modeling with a class-based TF-IDF procedure*. 2022.
- X. Yan, J. Guo, Y. Lan, X. Cheng. *A Biterm Topic Model for Short Texts*. WWW 2013.
- J. Yin, J. Wang. *A Dirichlet Multinomial Mixture Model-based Approach for Short Text Clustering*. KDD 2014.
- Mozilla. *Under the hood: How Firefox suggests tab groups with local AI*. 2025. https://blog.mozilla.org/en/mozilla/ai/ai-tech/ai-tab-groups/
- Chrome for Developers. *Prompt API* (extensions). https://developer.chrome.com/docs/extensions/ai/prompt-api
