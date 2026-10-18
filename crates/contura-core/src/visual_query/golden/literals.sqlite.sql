SELECT o.id
FROM orders AS o
WHERE o.status = 'it''s'
  AND o.note <> 'a\b'
  AND o.total > 12.5
  AND o.id <= 5
  AND o.ref = '12'
  AND o.channel IN ('app', 'kiosk, web')
  AND o.total BETWEEN 10 AND 20
  OR o.deleted_at IS NULL
  AND o.paid = 1
  AND o.status NOT LIKE '%test%'
  AND o.id LIKE '1%'
  AND o.channel NOT IN ('it''s', 'fax')
  OR o.deleted_at IS NOT NULL
