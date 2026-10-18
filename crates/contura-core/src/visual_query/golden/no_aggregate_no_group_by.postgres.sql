SELECT o.id,
       s.city
FROM public.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
