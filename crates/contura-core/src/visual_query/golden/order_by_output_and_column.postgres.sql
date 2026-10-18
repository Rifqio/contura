SELECT o.id,
       o.total AS amount
FROM public.orders AS o
ORDER BY amount DESC, o.placed_at, o.id
