SELECT o.id,
       c.name
FROM public.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN public.customers AS c ON c.id = o.customer_id AND c.store_id = s.id
