# Admin Bootstrap

Monrad Estimator uses a **deliberate bootstrap flow** to create the first global admin
user. There are no default admin credentials. The bootstrap path is permanently disabled
once a single `ADMIN` role user exists in the database.

## Quick start — local development

With both servers running against a **fresh/empty database**:

```bash
curl -X POST http://localhost:3001/api/bootstrap/admin \
  -H "Content-Type: application/json" \
  -d '{"name":"Your Name","email":"admin@example.com","password":"your-secure-password"}'
```

**Response (201):**

```json
{
  "token": "eyJhbGci...",
  "user": {
    "id": "clx...",
    "email": "admin@example.com",
    "name": "Your Name",
    "role": "ADMIN"
  }
}
```

## Fresh deployment (staging / production)

1. Deploy the app with an empty database.
2. Run the bootstrap command once (see above) to create the first admin.
3. Log in with the admin credentials you just created.
4. Global Resource Types and Rate Cards are now editable.

> **Do not script this into deployment pipelines.** The bootstrap step is intentionally
> a one-time manual action to avoid insecure default credentials in infrastructure.

## Existing database with users but no admin

If your database has regular `USER` accounts but no `ADMIN` has been created yet, the
bootstrap endpoint is still available. Create a new admin account with a different email:

```bash
curl -X POST http://localhost:3001/api/bootstrap/admin \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin Name","email":"admin@yourcompany.com","password":"secure-password"}'
```

> Bootstrap does **not** promote existing regular users. Use a new email for the admin
> account, or delete/re-create the regular user with `ADMIN` role directly in PostgreSQL.

## Normal registration remains unchanged

The regular `/api/auth/register` endpoint always creates `USER` accounts. There is no
automatic promotion to `ADMIN` through normal registration, even on a fresh database.

This is deliberate — knowing an admin exists cannot be inferred from the register
endpoint's behaviour.

## How it works

The bootstrap check+create runs inside a **Prisma `$transaction`** with a
**PostgreSQL advisory transaction lock** (`pg_advisory_xact_lock`).

| Step | Behaviour |
|------|-----------|
| `POST /api/bootstrap/admin` | Opens a database transaction and acquires `pg_advisory_xact_lock(900000001)` |
| Inside the lock | Checks `prisma.user.count({ where: { role: 'ADMIN' } })` |
| No admin exists | Creates the user with `role: ADMIN` and returns a JWT |
| Admin already exists | Returns **409 Conflict** — endpoint is permanently disabled |
| Email already taken | Returns **409 Conflict** — use a different email |
| Transaction commits | The lock is released automatically when the transaction ends |

### Concurrency safety

The PostgreSQL advisory transaction lock serialises all bootstrap attempts.
If two requests arrive at the same time:

1. Both open a transaction.
2. Both try to acquire the same advisory lock.
3. **One succeeds** and proceeds — it checks for an existing admin (none),
   checks email uniqueness, creates the admin, and commits.
4. **The other waits** — when it acquires the lock, the first request has
   already committed. The admin count check now sees an `ADMIN` user and
   returns **409 Conflict**.

This guarantees that only one admin can ever be created, even under racy
conditions — concurrent requests never observe a stale snapshot of zero
admins.

### Safety properties

- **No default credentials** — bootstrap is always a manual step with user-chosen
  credentials.
- **One-time gate** — once the first admin exists, the endpoint is dead. There is no
  bypass, no hidden flag, no env-var override.
- **Normal registration** always creates `USER`. An attacker cannot register as admin.
- **Email conflict prevention** — bootstrap will not silently promote an existing
  regular user to admin. Use a dedicated email for the admin account.
- **No privilege escalation** — second/subsequent users are always `USER` through
  normal registration.
- **Idempotent lockout** — calling bootstrap after an admin exists always returns 409.
  The PostgreSQL advisory transaction lock serialises concurrent bootstrap attempts,
  so only one admin can ever be created.

## Recovery scenarios

### Users exist but no admin (e.g. migrated from an older deployment)

The bootstrap endpoint still works because no `ADMIN` exists. Create an admin with a
fresh email as described above.

### Lost admin password

Use the standard "Forgot password" flow — it works for all users regardless of role.

### Need to revoke admin / promote a user

These operations require direct database access and are out of scope for the bootstrap
feature:

```sql
-- Check current admin(s)
SELECT id, email, name, role FROM "User" WHERE role = 'ADMIN';

-- Demote an admin to regular user
UPDATE "User" SET role = 'USER' WHERE email = 'admin@example.com';

-- Promote a user to admin (use only when no bootstrap endpoint is available
-- and you understand the security implications)
UPDATE "User" SET role = 'ADMIN' WHERE email = 'user@example.com';
```

> **Note:** Promoting an existing user via SQL bypasses the bootstrap gate. Use this
> only for operational recovery, not as a routine process.

## Why not default credentials?

- **Compromise surface** — a default `admin/admin` credential that must be changed on
  first login is at risk of being forgotten, left unchanged, or checked into source
  control.
- **Observability** — bootstrap is a single clear API call. It appears in server logs
  and is auditable.
- **Simplicity** — no special seed scripts, no environment variables, no first-run
  wizard UI. The same endpoint works for local dev, CI, staging, and production.
