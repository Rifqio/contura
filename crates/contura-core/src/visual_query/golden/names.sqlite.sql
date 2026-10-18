SELECT o."select",
       o."First Name",
       o."say ""hi""",
       o."back`tick",
       c."café",
       c.Id AS "Customer Id"
FROM "order" AS o
JOIN Customers AS c ON c.Id = o.CustomerId
WHERE o."select" = 'x'
ORDER BY "Customer Id" DESC, o."First Name"
