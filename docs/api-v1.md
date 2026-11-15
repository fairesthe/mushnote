# external api v1

for scripts, other apps, and automations. each integration should use its own mushnote user.

base url: `http://your-host:3000`

auth: `Authorization: Bearer <token>` on all note routes

## register a user

admin session:

```http
POST /api/v1/auth/register
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "username": "my_bot", "password": "at-least-8-chars" }
```

or with `integrations.registration_secret` in `vault/system/config.yaml`:

```json
{ "username": "my_bot", "password": "at-least-8-chars", "registration_secret": "..." }
```

response includes `token` and `user` (same shape as login).

## login

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "user_id": "my_bot", "password": "..." }
```

## list notes

```http
GET /api/v1/notes
Authorization: Bearer <token>
```

## read a note

```http
GET /api/v1/notes/file?id=folder/note.md
Authorization: Bearer <token>
```

## create or replace

```http
PUT /api/v1/notes/file
Authorization: Bearer <token>
Content-Type: application/json

{
  "note_id": "integrations/my_bot/diary.md",
  "title": "optional title",
  "content": "markdown body"
}
```

## append

```http
PATCH /api/v1/notes/file
Content-Type: application/json

{
  "note_id": "integrations/my_bot/diary.md",
  "append": "more text\\n"
}
```

## discovery

`GET /api/v1` returns a short route list.