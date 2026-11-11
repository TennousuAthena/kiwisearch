# Experiments

Offline experiments on ranking quality. They import the production code from `@kiwi-search/core`, so what is measured is what ships.

## Jev reranking on TREC DL 2019 (`docs/experiments/jev-rerank-trecdl19.md`)

```sh
pnpm install
pnpm --filter @kiwi-search/experiments cli fetch-data                 # 43 queries x 30 judged passages, ~1300 small requests to Hugging Face
TYPESAFE_API_KEY=... pnpm --filter @kiwi-search/experiments cli collect score4-snippet --limit 3   # smoke test
TYPESAFE_API_KEY=... pnpm --filter @kiwi-search/experiments cli collect score4-snippet
pnpm --filter @kiwi-search/experiments cli analyze
```

`collect` sends one System One request per candidate (about 1300 per variant, a few cents) and saves the raw answers under `results/`. `analyze` is offline: it recomputes every ranking and metric from the saved answers. `data/` and `results/` are not committed; the report in `docs/experiments/` is.
