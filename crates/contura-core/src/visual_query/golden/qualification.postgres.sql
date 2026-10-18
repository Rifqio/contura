SELECT o.id,
       s.name,
       o2.archived_at
FROM sales.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN "Archive".orders AS o2 ON o2.id = o.id
