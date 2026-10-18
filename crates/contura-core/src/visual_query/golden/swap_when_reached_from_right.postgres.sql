SELECT s.name,
       o.id AS order_id,
       c.id AS customer_id
FROM public.stores AS s
RIGHT JOIN public.orders AS o ON o.store_id = s.id
LEFT JOIN public.customers AS c ON c.store_id = s.id
