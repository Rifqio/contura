SELECT o.id,
       c.name
FROM public.orders AS o
LEFT JOIN public.customers AS c ON c.id = o.customer_id
WHERE o.status = 'late'
ORDER BY o.id DESC
LIMIT 100
