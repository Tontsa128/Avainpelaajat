# Avainpelaaja OS API

Base URL: `http://127.0.0.1:8080`.

## Health
- `GET /api/health`
- `GET /api/health/db`

## Authentication
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `POST /api/auth/password`

Authenticated requests use `Authorization: Bearer <token>` and `x-organization-id`.

## Resources
- `/api/sellers`
- `/api/places`
- `/api/bookings`
- `/api/records/:kind`
- `/api/workspace`
- `/api/sync`
- `/api/geocode`
- `/api/pois`

## Roles
Admin, Buukkaaja, Esihenkilö, Myyjä, Raportointikäyttäjä.

Authorization is enforced server-side and data is organization-scoped.
