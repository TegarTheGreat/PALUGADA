-- The currency the owner reads money in, and the rate they read it at (the
-- analysis of 3 October, §2.3 item 3 and §9 P1 item 13).
--
-- PALUGADA counts in US dollars, because providers price their models in
-- them, and every amount says so (2.98). An owner who thinks in rupiah
-- converted each one in their head. They may choose a currency to read
-- amounts in, at a rate they set; nothing is stored or charged in it.
--
-- On platform_control with the panel's language (0052), because it is the
-- one owner's (NG3) and follows them to every device. Both or neither: a
-- currency without a rate could not be shown, and a rate without one means
-- nothing. The code's shape is checked here and its existence by the owner
-- API, which knows the currencies; the rate is a positive number.

ALTER TABLE platform_control
  ADD COLUMN display_currency text,
  ADD COLUMN display_rate numeric,
  ADD CONSTRAINT platform_display_currency_code
    CHECK (display_currency IS NULL OR display_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT platform_display_currency_has_rate
    CHECK ((display_currency IS NULL) = (display_rate IS NULL)),
  ADD CONSTRAINT platform_display_rate_positive
    CHECK (display_rate IS NULL OR display_rate > 0);
