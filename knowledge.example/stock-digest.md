---
title: The weekly stock digest
source: Portfolio, Projects
url: https://example.com/sam/stock-digest
keywords: built, project, projects, stock, digest, weekly, report, inventory, slack, summary
---

I built a weekly stock digest for Lanterna Books. Every Monday it reads the inventory export, lists the titles that are running low and posts a short summary in the team chat.

## How it works

A scheduled job loads the export and a model writes the summary from the rows it is given. The numbers in the summary are copied from the export by code, so the model never does arithmetic.
