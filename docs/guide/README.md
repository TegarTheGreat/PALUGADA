# The PALUGADA guide

This guide is for the person who owns and runs a PALUGADA deployment. It
explains what the platform does, walks through the first hour, and then
covers day-to-day use, running it for real, and what to expect at each size.
Every setting is listed in [docs/configuration.md](../configuration.md); this
guide links there rather than repeating the tables.

## What PALUGADA is

PALUGADA is a self-hosted control plane for companies whose work is done by AI
agents and whose only human is you, the owner. The agents do the work through
capabilities the platform brokers, each classified by how hard it is to undo,
and money is reserved before any work starts. Your job is one inbox of
decisions: anything irreversible waits for you and your authenticator, and
anything you never answer is cancelled rather than carried out.

## The pages

| Page | What it is for |
|---|---|
| [Getting started](getting-started.md) | Installing with Docker Compose or on this machine, `npm run setup`, the first sign-in, the first company and its first piece of work |
| [Concepts](concepts.md) | Every idea the console shows you, explained once: companies, roles, tiers, budgets, the inbox, memory, runtimes and the rest |
| [How-to](how-to.md) | Recipes with exact steps: approving, answering, rerunning, hiring, connecting vendors and MCP servers, models, agent CLIs, schedules, triggers, bundles, languages, budgets, notifications, export |
| [Operations](operations.md) | Running it for real: HTTPS, secrets, backups, upgrades, monitoring, more than one worker, sizing, the database roles |
| [Scale](scale.md) | What to set up and watch for a small, medium, large or enterprise deployment, and what is not there yet |
| [Troubleshooting](troubleshooting.md) | Messages the platform prints, what causes each, and what to do |

## Your first hour

This tour assumes nothing is installed yet. Each step names the console screen
and what to look at on it. The console has a sidebar: **Home** at the top,
then the chosen company's **Inbox**, **Overview**, **Work**, **Team**,
**Memory**, **Money** and **History**, and **Settings** and
**Stop everything** at the foot. On a phone the same pages are in a tab bar
along the bottom and under **More**.

1. **Install.** Follow [Getting started](getting-started.md). `npm run setup`
   asks where PALUGADA runs, enrols your authenticator app with a QR code, and
   asks which model does the work. It proves the model answers and calls
   tools before it writes anything. Then start it with
   `docker compose up -d --build`, or with `npm start` on this machine.

2. **Sign in.** Open `http://127.0.0.1:8787`. The page says
   **Welcome back** and asks for the six-digit code from your authenticator
   app. There are no user names or passwords: PALUGADA has one human, and the
   code is the proof. The session lives in that browser tab only, so closing
   the tab signs you out. The first time, the console walks you through
   itself, moving to each page it describes; **Skip the tour** ends it, and
   **Take the tour** in the menu under **Owner** shows it again.

3. **Start a company.** On **Home**, press **Start a company**. Give it a
   **Name**; the **Short name** fills itself in and is used in links and
   exports. Leave **Let it run itself** on if you want a strategist that
   reviews the week every Monday and proposes what to do next. Press
   **Start it** and confirm with a code, because creating a company writes
   divisions, roles, grants and budgets. You land on the company's
   **Overview**. Look at the stage card (no stage is set yet), the goal
   ladder under **Goals**, and the budget for the period.

   While you are there, look at the foot of the sidebar. If the deployment
   is missing something optional, a **Finish setting up** card lists what it
   reported at boot: no push channel, no vendor file, no price list, and so
   on. Each line is something switched off until it is configured.

4. **Give it work.** Press **New** in the sidebar and choose
   **Give a role work**, or press **Give work** on the **Work** page. The
   **Role** is the coordinator unless you choose another; the coordinator
   decides whose job it is and hands it over. Pick the goal it **Serves**,
   write **What to do** in plain words, and press **Assign it**. The role is
   woken at once rather than at its next heartbeat.

5. **Watch it.** The **Work** page lists every task, filtered as
   **Running**, **Waiting**, **Done** or **Stopped**. The coordinator's task
   shows sub-tasks as other roles take parts of it. Open a task to see its
   progress from its own journal, the step it is on, when its worker last
   checked in, **What it did** (its events) and **What it said** (what its
   runs wrote as they worked). To steer it while it runs, write a note under
   **Steer it** and press **Tell it**; its next run reads it. **Home** shows
   the same thing across every company under **Happening now**.

6. **Answer the inbox.** When something needs you, it appears in the
   company's **Inbox** and in **Needs you** on **Home**, and on your phone if
   push or Telegram is set up. The item says **What will happen**, **Why**,
   **If you refuse**, the goal it serves, the tier and the
   **Estimated cost**; **What happened** opens the step-by-step trace. Press
   **Approve**, **Deny** or **Ask a question**. A tier 3 action asks for a
   fresh code. A question from an agent has its own box: write the answer
   and press **Send the answer**. Unanswered items expire into a
   cancellation, and the badge says when.

7. **See what it delivered.** Finished tasks move to **Done** on the
   **Work** page and to **Just delivered** on **Home**. Open one to read
   **What it produced**: its summary, drafts and emails, each readable in
   full. Under **Your word on it**, press **Good** or **Needs work** and say
   why; the division reads your note on its next run, and it is placed first
   in what the company knows. Your decisions, with your notes, are kept in
   **History**, and what the company has learned is in **Memory**.

8. **Set up what comes next.** In rough order of value:
   - the monthly ceiling on **Money** (USD 200 a company by default);
   - push notifications or Telegram, so the inbox reaches your phone
     ([how-to](how-to.md#push-notifications-and-telegram));
   - the company's languages under **Settings**, **Languages**
     ([how-to](how-to.md#set-the-companys-languages));
   - a vendor file for the capabilities that need somebody's account, such as
     sending email ([how-to](how-to.md#connect-a-vendor));
   - your own goals on **Team**, **Goals**, with a number to measure each by;
   - schedules and triggers on **Team**, so work starts without you;
   - HTTPS and backups before the deployment matters to anyone
     ([operations](operations.md)).

If something in this tour did not happen the way it is described, the
[troubleshooting](troubleshooting.md) page lists the messages you are likely
to see and what each one means.
