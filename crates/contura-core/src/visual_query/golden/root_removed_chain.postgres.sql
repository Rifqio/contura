SELECT s.name AS s_name,
       r.name AS r_name,
       c.email
FROM public.stores AS s
JOIN public.regions AS r ON r.id = s.region_id
CROSS JOIN public.customers AS c
LIMIT 100
