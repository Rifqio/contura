SELECT o.id,
       s.name AS s_name,
       s2.name AS s2_name
FROM public.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN public.stores AS s2 ON s2.id = o.pickup_store_id
