SELECT o.id,
       s.city,
       r.code
FROM public.orders AS o
CROSS JOIN public.stores AS s
JOIN public.regions AS r ON r.id = s.region_id
WHERE s.city = 'Oslo'
ORDER BY r.code
