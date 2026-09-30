# Coolify and Dokploy

[Coolify](https://coolify.io) and [Dokploy](https://dokploy.com) are
self-hosted platforms that build an application from a git repository, run
it with Docker Compose, and put HTTPS in front of it. PALUGADA has a compose
file for each, in `deploy/coolify/` and `deploy/dokploy/`: the platform, a
PostgreSQL 16 with pgvector beside it, and nothing from the repository
mounted into either.

What makes this work without a terminal on the server:

- **The image sets its own database up.** Given the database superuser's
  address, it makes the three roles, the database and the extensions before
  it starts, migrates, and then starts the platform without the superuser's
  or the schema owner's address, or any database password it was handed
  ([Running the image by itself](operations.md#running-the-image-by-itself)).
  A redeploy does it again and changes nothing.
- **The first owner claims it with a link.** No authenticator secret is
  needed in the environment: a deployment with no owner prints a link in its
  log, and whoever opens it first adds their authenticator app and is the
  owner ([Sign in for the first time](getting-started.md#sign-in-for-the-first-time)).
- **The platform's proxy is trusted for the caller's address**
  (`PALUGADA_BEHIND_PROXY=1`), and the console answers only to the domain you
  give it.

Everything else -- the model, agent CLIs, channels, MCP servers -- is set in
the console after you sign in, as on any other deployment.

## Coolify

1. **+ New**, then **Public Repository** with this repository's URL (for a
   fork you keep private, **Private Repository (with GitHub App)**). Choose
   the branch to deploy.
2. **Build Pack**: **Docker Compose**. **Base Directory**: `/`.
   **Docker Compose Location**: `/deploy/coolify/docker-compose.yml`.
3. Coolify reads the file and lists two services. Give **app** a domain, such
   as `https://palugada.example.com`. Leave **db** without one: nothing but
   the app should reach it.
4. **Deploy.** The first deploy builds the image, which takes a few minutes.
5. Open the **app** service's logs, find the line that starts
   `palugada: no owner yet: open`, and open the link it names. Add the secret
   it shows to your authenticator app and type the code the app shows.

Coolify generated what the file asks for the first time it read it, and keeps
it under **Environment Variables**:

| Variable | What it is |
|---|---|
| `SERVICE_PASSWORD_POSTGRES` | The database superuser's password. The app uses it to set the database up before it starts, and does not keep it |
| `SERVICE_PASSWORD_DBOWNER`, `_DBAPP`, `_DBADMIN` | The three roles' passwords ([The database roles](operations.md#the-database-roles)) |
| `SERVICE_HEX_64_MASTERKEY` | The key that seals what you save in the console. **Copy it somewhere apart from the database's backups**: a restored database without it cannot open the keys it holds |
| `SERVICE_URL_APP`, `SERVICE_FQDN_APP` | The domain you gave **app**, which becomes `PALUGADA_APP_URL_PUBLIC` |

Do not change the passwords once the database exists without changing them
in the database too: the app sets each role's password to its variable at
every start, but the superuser's is the database's own. Add any other
setting from [docs/configuration.md](../configuration.md) on the same tab;
Coolify gives every service of the resource all of them.

A domain added later, or a second domain, needs a redeploy, and a second
domain also needs `PALUGADA_ALLOWED_HOSTS` listing both: the console refuses
any name it was not told with `421` and `owner.wrong_host`.

## Dokploy

1. In a project, **Create Service**, then **Compose**. Keep the type
   **Docker Compose**: a **Stack** cannot build the image and does not wait
   for the database.
2. **Provider**: **Git** with this repository's URL (or **GitHub**), and the
   branch. **Compose Path**: `./deploy/dokploy/docker-compose.yml`.
3. **Environment**, with a long random value of letters and digits for each
   password (`openssl rand -hex 24` makes one), and your domain:

   ```
   PALUGADA_DB_SUPERUSER_PASSWORD=…
   PALUGADA_DB_OWNER_PASSWORD=…
   PALUGADA_DB_APP_PASSWORD=…
   PALUGADA_DB_ADMIN_PASSWORD=…
   PALUGADA_APP_URL_PUBLIC=https://palugada.example.com
   ```

   A deploy with one of these missing stops and names it. Add
   `PALUGADA_MASTER_KEY=` and 64 hex characters (`openssl rand -hex 32`) to
   keep the master key here rather than in the `home` volume, and copy it
   somewhere apart from the database's backups either way. Any other setting
   from [docs/configuration.md](../configuration.md) goes here too.
4. **Domains**: add the same domain for service **app**, port **8787**, with
   HTTPS on.
5. **Deploy**, then open the **app** container's logs, find
   `palugada: no owner yet: open`, and open the link.

Leave **Advanced**, **Mounts** empty: PALUGADA needs none, and a mount makes
Dokploy run Compose from the repository's root, where the file's paths no
longer point. Leave **Randomize Compose** off: it renames the `db` service,
which the database addresses name. Never redeploy with **fresh volumes**: it
deletes the database.

Dokploy's outgoing notifications can start work in PALUGADA: a
[trigger](how-to.md#let-other-services-start-work-triggers) with the bearer
scheme, and the notification's custom header set to
`Authorization: Bearer <the trigger's token>`.

## Backups

The database is in the `database` volume and the master key in the platform's
environment or the `home` volume. Back up the database as
[Backups](operations.md#backups) says, and the master key apart from it.

- **Dokploy** backs up a PostgreSQL service inside a compose stack on a
  schedule, to S3: under the compose service's **Backups**, choose service
  `db`, database `palugada`, user `postgres` and the superuser's password.
- **Coolify's** scheduled database backups are for databases it runs as a
  database resource, not one inside a compose application. Run `pg_dump`
  from the server on a schedule and keep the file off it:

  ```sh
  docker exec "$(docker ps -qf name=db-)" pg_dump -U postgres -Fc palugada > palugada.dump
  ```

## Upgrading

Deploy again. The image migrates before the platform starts, under a lock,
so a redeploy of a newer version brings the database up to it; the database
is never behind the code that runs. What each version changed is in
`CHANGELOG.md`.
