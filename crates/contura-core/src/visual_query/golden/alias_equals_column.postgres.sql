SELECT o.id,
       c.id AS customer_id,
       c.name
FROM public.orders AS o
LEFT JOIN public.customers AS c ON c.id = o.customer_id
ORDER BY o.id DESC, customer_id
