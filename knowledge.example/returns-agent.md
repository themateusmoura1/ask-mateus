---
title: The returns agent
source: Portfolio, Projects
url: https://example.com/sam/returns-agent
keywords: built, build, project, projects, agent, returns, refund, email, approval, how, works, architecture, design, wrong, fixed
---

I built a returns agent for Lanterna Books. A customer emails about a return, the agent finds the order, checks it against the returns policy and drafts a reply. A person approves the reply before it is sent.

## How it works

The agent has three tools: look up an order, read the policy, save a draft. It has no tool that sends email. Sending happens in the help desk after a person clicks approve.

The main design choice was to keep the policy as one short document the agent reads every time, so changing the policy needs no code change.

What went wrong: early on the agent approved returns for orders it could not find. I fixed it by making "order not found" a result the agent must report, and the draft now says so plainly.
