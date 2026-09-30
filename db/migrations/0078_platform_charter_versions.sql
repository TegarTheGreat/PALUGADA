-- One platform charter per version.
--
-- `charters` has UNIQUE (company_id, version), and the platform's charter is
-- the row whose company_id is null. Null is not equal to null, so the
-- constraint never applied to the one charter that outranks every company's
-- (F3.1): two writers could each publish a version 1, and "which platform
-- charter was this run subject to" would have two answers. Nothing wrote the
-- platform's charter concurrently until the deployment began publishing a
-- default one at boot, which every replica does.
CREATE UNIQUE INDEX charters_platform_version ON charters (version) WHERE company_id IS NULL;
