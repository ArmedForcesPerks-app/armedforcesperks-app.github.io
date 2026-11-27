# Temporary research branch (Near me map work)

Not for merging. `research/jobs.json` lists jobs; each push that changes it runs them on GitHub Actions
(`.github/workflows/map-research.yml`) and commits their output to `research/out/<batch>/<job>/`.
Data sources: OpenStreetMap (ODbL), All the Places (CC0), U.S. Census Bureau, DoD DISDI, Wikidata (CC0).
