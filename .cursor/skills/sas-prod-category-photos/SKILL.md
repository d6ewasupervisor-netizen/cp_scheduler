---
name: sas-prod-category-photos
description: >-
  Upload before/after category-reset photos on a SAS PROD visit. Use when PATCHing category-resets with before/after image base64, compress_image, or category photo slots.
---

# Category-reset before/after photos

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Endpoint

`PATCH https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/`

One PATCH per photo.

## Bodies

```json
{
  "before": {
    "image": {
      "filetype": "image/jpeg",
      "filename": "store-111_01-before-01.jpg",
      "filesize": 3142692,
      "base64": "<jpeg-base64>"
    }
  },
  "compress_image": true
}
```

```json
{
  "after": {
    "image": {
      "filetype": "image/jpeg",
      "filename": "store-111_02-after-01.jpg",
      "filesize": 2924503,
      "base64": "<jpeg-base64>"
    }
  },
  "compress_image": true
}
```

Extra category evidence (clipstrips, endcaps, etc.) folds into additional **after** PATCHes on the same reset row.

## Notes

- Resolve `resetId` from `GET …/category-resets/` (CP usually has one "PET CARE SUPPLIES" row).
- Success message: "Category Reset Item images updated successfully."

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
