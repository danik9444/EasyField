begin;

-- Stage B of the customer generation data plane: the server-authoritative
-- price catalog, seeded INERT from a checked-in, human-reviewed manifest.
--
-- The manifest is supabase/pricing/generation-price-manifest.v1.json. It is the
-- reviewed artefact; this migration is a mechanical transcription of it, and
-- tests/generation-price-manifest.test.mjs asserts the two agree row for row.
--
-- Three things this migration deliberately does.
--
-- 1. IT ADDS THE MISSING IMMUTABILITY TRIGGER. The generation price catalog was
--    created in 20260715175329 with no trigger of any kind and with
--    "grant select, insert, update, delete ... to service_role". The protection
--    everyone assumed it had (the plan_catalog pattern at 202607140001:555) was
--    never there, so until now any service-role connection could rewrite a live
--    price with no migration and no evidence. Seeding without fixing that would
--    make "seeding is a one-way commitment" simply untrue, so the trigger is
--    created BEFORE the first row is inserted and the write grants are revoked
--    in the same transaction. public.easyfield_generation_prepare is
--    security definer, so it keeps reading the catalog as before.
--
--    Changing a seeded price now costs a forward-only migration that locks the
--    table, proves no non-terminal generation_gateway_jobs row references the
--    pricing_key, disables this one trigger, updates, and re-enables it —
--    exactly the shape of 202607290002_creator_annual_price_240.sql. That is
--    not friction for its own sake: easyfield_generation_prepare's replay guard
--    compares eight catalog-derived fields against an existing job, so mutating
--    create_path, poll_path, model_id or action under an in-flight operation
--    makes every retry of it raise 22000 for ever.
--
-- 2. IT SEEDS active = false. Nothing here can charge anyone. Turning a price on
--    is a separate, deliberate migration, and it will have to do the
--    disable-trigger dance above, which is the point: activation should be a
--    decision with a paper trail, not a side effect of a seed.
--
-- 3. IT COMMITS A PRICE RULE WITHOUT CHANGING A PRICE. One EasyField credit is
--    one upstream provider credit. That is not a markup invented here: it is
--    what the desktop client already charges (every generation screen renders
--    the provider-reported creditsConsumed directly as "Charged N cr"), and it
--    is the only ratio at which billing_private.plan_catalog's credit prices
--    reproduce the blessed 39.4%-73.3% margin band against $0.005 per provider
--    credit. All margin lives in the sale price of an EasyField credit; this
--    catalog encodes a unit conversion. See the manifest's price_rule block.
--
--    customer_microcredits_per_unit         = provider_credits_per_unit * 1e6
--    provider_cost_currency_micros_per_unit = provider_credits_per_unit * 5000
--
--    Note for anyone auditing this later: the "customer/100 >= provider*2"
--    margin-floor check proposed in the design document is a tautology under
--    this rule -- both sides are identically provider_credits * 10000 for every
--    possible row. It cannot fail and must not be presented as a safety check.
--
-- Provider cost is derived from the feed's creditPrice * 5000, not from its
-- usdPrice * 1e6. 399 of the 404 rows returned on 2026-08-06 agree; the ones
-- that do not include a ten-fold usdPrice error on one row and 1.85 against an
-- implied 1.90 on Veo 3.1 Quality-4K text-to-video. Both derivations are
-- recorded per row in the manifest so the disagreement stays visible.
--
-- What is NOT seeded, and why, is listed in full at the bottom of this file.

lock table billing_private.generation_price_catalog in access exclusive mode;

-- Fail closed rather than seed on top of an unknown catalog state. The table is
-- empty today; a replay after this migration already reached its target is
-- allowed, and every other starting state needs an explicit follow-up.
do $$
declare
  v_rows bigint;
  v_target bigint;
begin
  select count(*) into v_rows from billing_private.generation_price_catalog;
  select count(*) into v_target
  from billing_private.generation_price_catalog
  where pricing_version = 'generation-2026-08-06-manifest-v1';

  if v_rows <> 0 and v_rows <> v_target then
    raise exception 'generation_price_catalog holds % rows from another revision', v_rows - v_target;
  end if;
  if v_rows <> 0 and v_rows <> 130 then
    raise exception 'generation_price_catalog is partially seeded at % of 130 rows', v_rows;
  end if;
  if exists (
    select 1 from billing_private.generation_price_catalog where active
  ) then
    raise exception 'generation_price_catalog already has an active price; this seed must stay inert';
  end if;
end $$;

-- Append-only from the first row onward, not from the first revision onward.
drop trigger if exists generation_price_catalog_is_immutable
  on billing_private.generation_price_catalog;
create trigger generation_price_catalog_is_immutable
before update or delete on billing_private.generation_price_catalog
for each row execute function billing_private.reject_immutable_mutation();

insert into billing_private.generation_price_catalog (
  pricing_key,
  model_id,
  action,
  family,
  create_path,
  poll_path,
  customer_microcredits_per_unit,
  provider_cost_currency_micros_per_unit,
  provider_cost_currency_code,
  pricing_version,
  maximum_units,
  active
)
select
  seed.pricing_key,
  seed.model_id,
  seed.action,
  seed.family,
  seed.create_path,
  seed.poll_path,
  seed.customer_microcredits_per_unit,
  seed.provider_cost_currency_micros_per_unit,
  'USD',
  'generation-2026-08-06-manifest-v1',
  seed.maximum_units,
  false
from (
  values
    ('aleph:easyfield/runway-aleph:default', 'easyfield/runway-aleph', 'video.edit', 'aleph',
     '/api/v1/aleph/generate', '/api/v1/aleph/record-info',
     110000000, 550000, 1),
    ('jobs:bytedance/seedance-2-fast:res=480p+input=none', 'bytedance/seedance-2-fast', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     15500000, 77500, 15),
    ('jobs:bytedance/seedance-2-fast:res=480p+input=video', 'bytedance/seedance-2-fast', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     9000000, 45000, 15),
    ('jobs:bytedance/seedance-2-fast:res=720p+input=none', 'bytedance/seedance-2-fast', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     33000000, 165000, 15),
    ('jobs:bytedance/seedance-2-fast:res=720p+input=video', 'bytedance/seedance-2-fast', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     20000000, 100000, 15),
    ('jobs:bytedance/seedance-2-mini:res=480p+input=none', 'bytedance/seedance-2-mini', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     9500000, 47500, 15),
    ('jobs:bytedance/seedance-2-mini:res=720p+input=none', 'bytedance/seedance-2-mini', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     20500000, 102500, 15),
    ('jobs:bytedance/seedance-2:res=1080p+input=none', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     102000000, 510000, 15),
    ('jobs:bytedance/seedance-2:res=1080p+input=video', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     62000000, 310000, 15),
    ('jobs:bytedance/seedance-2:res=480p+input=none', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     19000000, 95000, 15),
    ('jobs:bytedance/seedance-2:res=480p+input=video', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     11500000, 57500, 15),
    ('jobs:bytedance/seedance-2:res=4K+input=none', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     208000000, 1040000, 15),
    ('jobs:bytedance/seedance-2:res=4K+input=video', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     128000000, 640000, 15),
    ('jobs:bytedance/seedance-2:res=720p+input=none', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     41000000, 205000, 15),
    ('jobs:bytedance/seedance-2:res=720p+input=video', 'bytedance/seedance-2', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     25000000, 125000, 15),
    ('jobs:elevenlabs/text-to-dialogue-v3:default', 'elevenlabs/text-to-dialogue-v3', 'audio.speech', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     14000, 70, 5000),
    ('jobs:elevenlabs/text-to-speech-multilingual-v2:default', 'elevenlabs/text-to-speech-multilingual-v2', 'audio.speech', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     12000, 60, 5000),
    ('jobs:elevenlabs/text-to-speech-turbo-2-5:default', 'elevenlabs/text-to-speech-turbo-2-5', 'audio.speech', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6000, 30, 5000),
    ('jobs:flux-2/flex-image-to-image:res=1K', 'flux-2/flex-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     14000000, 70000, 1),
    ('jobs:flux-2/flex-image-to-image:res=2K', 'flux-2/flex-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 1),
    ('jobs:flux-2/flex-text-to-image:res=1K', 'flux-2/flex-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     14000000, 70000, 1),
    ('jobs:flux-2/flex-text-to-image:res=2K', 'flux-2/flex-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 1),
    ('jobs:flux-2/pro-image-to-image:res=1K', 'flux-2/pro-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5000000, 25000, 1),
    ('jobs:flux-2/pro-image-to-image:res=2K', 'flux-2/pro-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     7000000, 35000, 1),
    ('jobs:flux-2/pro-text-to-image:res=1K', 'flux-2/pro-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5000000, 25000, 1),
    ('jobs:flux-2/pro-text-to-image:res=2K', 'flux-2/pro-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     7000000, 35000, 1),
    ('jobs:gemini-omni-video:res=1080p+duration=10s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     126000000, 630000, 1),
    ('jobs:gemini-omni-video:res=1080p+duration=4s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     63000000, 315000, 1),
    ('jobs:gemini-omni-video:res=1080p+duration=6s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     84000000, 420000, 1),
    ('jobs:gemini-omni-video:res=1080p+duration=8s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     105000000, 525000, 1),
    ('jobs:gemini-omni-video:res=1080p+input=video', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     168000000, 840000, 1),
    ('jobs:gemini-omni-video:res=4k+duration=10s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     210000000, 1050000, 1),
    ('jobs:gemini-omni-video:res=4k+duration=4s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     147000000, 735000, 1),
    ('jobs:gemini-omni-video:res=4k+duration=6s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     168000000, 840000, 1),
    ('jobs:gemini-omni-video:res=4k+duration=8s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     189000000, 945000, 1),
    ('jobs:gemini-omni-video:res=4k+input=video', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     252000000, 1260000, 1),
    ('jobs:gemini-omni-video:res=720p+duration=10s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     126000000, 630000, 1),
    ('jobs:gemini-omni-video:res=720p+duration=4s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     63000000, 315000, 1),
    ('jobs:gemini-omni-video:res=720p+duration=6s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     84000000, 420000, 1),
    ('jobs:gemini-omni-video:res=720p+duration=8s+input=none', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     105000000, 525000, 1),
    ('jobs:gemini-omni-video:res=720p+input=video', 'gemini-omni-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     168000000, 840000, 1),
    ('jobs:gpt-image-2-image-to-image:res=1K', 'gpt-image-2-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6000000, 30000, 1),
    ('jobs:gpt-image-2-image-to-image:res=2K', 'gpt-image-2-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     10000000, 50000, 1),
    ('jobs:gpt-image-2-image-to-image:res=4K', 'gpt-image-2-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     16000000, 80000, 1),
    ('jobs:gpt-image-2-text-to-image:res=1K', 'gpt-image-2-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6000000, 30000, 1),
    ('jobs:gpt-image-2-text-to-image:res=2K', 'gpt-image-2-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     10000000, 50000, 1),
    ('jobs:gpt-image-2-text-to-image:res=4K', 'gpt-image-2-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     16000000, 80000, 1),
    ('jobs:hailuo/2-3-image-to-video-pro:res=1080p+duration=6.0s', 'hailuo/2-3-image-to-video-pro', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     80000000, 400000, 1),
    ('jobs:hailuo/2-3-image-to-video-pro:res=768p+duration=10.0s', 'hailuo/2-3-image-to-video-pro', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     90000000, 450000, 1),
    ('jobs:hailuo/2-3-image-to-video-pro:res=768p+duration=6.0s', 'hailuo/2-3-image-to-video-pro', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     45000000, 225000, 1),
    ('jobs:hailuo/2-3-image-to-video-standard:res=1080p+duration=6.0s', 'hailuo/2-3-image-to-video-standard', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     50000000, 250000, 1),
    ('jobs:hailuo/2-3-image-to-video-standard:res=768p+duration=10.0s', 'hailuo/2-3-image-to-video-standard', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     50000000, 250000, 1),
    ('jobs:hailuo/2-3-image-to-video-standard:res=768p+duration=6.0s', 'hailuo/2-3-image-to-video-standard', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     30000000, 150000, 1),
    ('jobs:happyhorse-1-1/image-to-video:res=1080p', 'happyhorse-1-1/image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     29000000, 145000, 15),
    ('jobs:happyhorse-1-1/image-to-video:res=720p', 'happyhorse-1-1/image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     22500000, 112500, 15),
    ('jobs:happyhorse-1-1/reference-to-video:res=1080p', 'happyhorse-1-1/reference-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     29000000, 145000, 15),
    ('jobs:happyhorse-1-1/reference-to-video:res=720p', 'happyhorse-1-1/reference-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     22500000, 112500, 15),
    ('jobs:happyhorse-1-1/text-to-video:res=1080p', 'happyhorse-1-1/text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     29000000, 145000, 15),
    ('jobs:happyhorse-1-1/text-to-video:res=720p', 'happyhorse-1-1/text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     22500000, 112500, 15),
    ('jobs:ideogram/v3-edit:rendering_speed=BALANCED', 'ideogram/v3-edit', 'image.inpaint', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     7000000, 35000, 1),
    ('jobs:kling-3.0/video:res=1080p+audio=off', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 15),
    ('jobs:kling-3.0/video:res=1080p+audio=on', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     27000000, 135000, 15),
    ('jobs:kling-3.0/video:res=4K+audio=off', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     67000000, 335000, 15),
    ('jobs:kling-3.0/video:res=4K+audio=on', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     67000000, 335000, 15),
    ('jobs:kling-3.0/video:res=720p+audio=off', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     14000000, 70000, 15),
    ('jobs:kling-3.0/video:res=720p+audio=on', 'kling-3.0/video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     20000000, 100000, 15),
    ('jobs:kling/v3-turbo-image-to-video:res=1080p', 'kling/v3-turbo-image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     22500000, 112500, 15),
    ('jobs:kling/v3-turbo-image-to-video:res=720p', 'kling/v3-turbo-image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 15),
    ('jobs:kling/v3-turbo-text-to-video:res=1080p', 'kling/v3-turbo-text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     22500000, 112500, 15),
    ('jobs:kling/v3-turbo-text-to-video:res=720p', 'kling/v3-turbo-text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 15),
    ('jobs:nano-banana-2-lite:default', 'nano-banana-2-lite', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     4000000, 20000, 1),
    ('jobs:nano-banana-2:res=1K', 'nano-banana-2', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     8000000, 40000, 1),
    ('jobs:nano-banana-2:res=2K', 'nano-banana-2', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     12000000, 60000, 1),
    ('jobs:nano-banana-2:res=4K', 'nano-banana-2', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 1),
    ('jobs:nano-banana-pro:res=1K', 'nano-banana-pro', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 1),
    ('jobs:nano-banana-pro:res=2K', 'nano-banana-pro', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     18000000, 90000, 1),
    ('jobs:nano-banana-pro:res=4K', 'nano-banana-pro', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 1),
    ('jobs:qwen2/image-edit:default', 'qwen2/image-edit', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5600000, 28000, 1),
    ('jobs:qwen2/text-to-image:default', 'qwen2/text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5600000, 28000, 1),
    ('jobs:recraft/crisp-upscale:default', 'recraft/crisp-upscale', 'image.upscale', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     500000, 2500, 1),
    ('jobs:recraft/remove-background:default', 'recraft/remove-background', 'image.remove-background', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     1000000, 5000, 1),
    ('jobs:seedream/4.5-edit:res=2K', 'seedream/4.5-edit', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6500000, 32500, 1),
    ('jobs:seedream/4.5-edit:res=4K', 'seedream/4.5-edit', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6500000, 32500, 1),
    ('jobs:seedream/4.5-text-to-image:res=2K', 'seedream/4.5-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6500000, 32500, 1),
    ('jobs:seedream/4.5-text-to-image:res=4K', 'seedream/4.5-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     6500000, 32500, 1),
    ('jobs:seedream/5-lite-image-to-image:res=2K', 'seedream/5-lite-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5500000, 27500, 1),
    ('jobs:seedream/5-lite-image-to-image:res=4K', 'seedream/5-lite-image-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5500000, 27500, 1),
    ('jobs:seedream/5-lite-text-to-image:res=2K', 'seedream/5-lite-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5500000, 27500, 1),
    ('jobs:seedream/5-lite-text-to-image:res=4K', 'seedream/5-lite-text-to-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     5500000, 27500, 1),
    ('jobs:wan/2-7-image-to-video:res=1080p', 'wan/2-7-image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 15),
    ('jobs:wan/2-7-image-to-video:res=720p', 'wan/2-7-image-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     16000000, 80000, 15),
    ('jobs:wan/2-7-image:res=1K', 'wan/2-7-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     4800000, 24000, 1),
    ('jobs:wan/2-7-image:res=2K', 'wan/2-7-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     4800000, 24000, 1),
    ('jobs:wan/2-7-image:res=4K', 'wan/2-7-image', 'image.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     12000000, 60000, 1),
    ('jobs:wan/2-7-r2v:res=1080p', 'wan/2-7-r2v', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 15),
    ('jobs:wan/2-7-r2v:res=720p', 'wan/2-7-r2v', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     16000000, 80000, 15),
    ('jobs:wan/2-7-text-to-video:res=1080p', 'wan/2-7-text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     24000000, 120000, 15),
    ('jobs:wan/2-7-text-to-video:res=720p', 'wan/2-7-text-to-video', 'video.generate', 'jobs',
     '/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo',
     16000000, 80000, 15),
    ('runway:easyfield/runway-video:mode=image-to-video+res=1080p+duration=5.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     30000000, 150000, 1),
    ('runway:easyfield/runway-video:mode=image-to-video+res=720p+duration=10.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     30000000, 150000, 1),
    ('runway:easyfield/runway-video:mode=image-to-video+res=720p+duration=5.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     12000000, 60000, 1),
    ('runway:easyfield/runway-video:mode=text-to-video+res=1080p+duration=5.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     30000000, 150000, 1),
    ('runway:easyfield/runway-video:mode=text-to-video+res=720p+duration=10.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     30000000, 150000, 1),
    ('runway:easyfield/runway-video:mode=text-to-video+res=720p+duration=5.0s', 'easyfield/runway-video', 'video.generate', 'runway',
     '/api/v1/runway/generate', '/api/v1/runway/record-detail',
     12000000, 60000, 1),
    ('sounds:easyfield/suno-sounds:default', 'easyfield/suno-sounds', 'audio.sfx', 'sounds',
     '/api/v1/generate/sounds', '/api/v1/generate/record-info',
     2500000, 12500, 1),
    ('suno:easyfield/suno-music:default', 'easyfield/suno-music', 'audio.music', 'suno',
     '/api/v1/generate', '/api/v1/generate/record-info',
     12000000, 60000, 1),
    ('veo:veo3:mode=image-to-video+res=1080p', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     255000000, 1275000, 1),
    ('veo:veo3:mode=image-to-video+res=4K', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     370000000, 1850000, 1),
    ('veo:veo3:mode=image-to-video+res=720p', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     250000000, 1250000, 1),
    ('veo:veo3:mode=text-to-video+res=1080p', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     255000000, 1275000, 1),
    ('veo:veo3:mode=text-to-video+res=4K', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     380000000, 1900000, 1),
    ('veo:veo3:mode=text-to-video+res=720p', 'veo3', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     250000000, 1250000, 1),
    ('veo:veo3_fast:mode=image-to-video+res=1080p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     65000000, 325000, 1),
    ('veo:veo3_fast:mode=image-to-video+res=4K', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     180000000, 900000, 1),
    ('veo:veo3_fast:mode=image-to-video+res=720p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     60000000, 300000, 1),
    ('veo:veo3_fast:mode=reference-to-video+res=1080p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     65000000, 325000, 1),
    ('veo:veo3_fast:mode=reference-to-video+res=4K', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     180000000, 900000, 1),
    ('veo:veo3_fast:mode=reference-to-video+res=720p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     60000000, 300000, 1),
    ('veo:veo3_fast:mode=text-to-video+res=1080p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     65000000, 325000, 1),
    ('veo:veo3_fast:mode=text-to-video+res=4K', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     180000000, 900000, 1),
    ('veo:veo3_fast:mode=text-to-video+res=720p', 'veo3_fast', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     60000000, 300000, 1),
    ('veo:veo3_lite:mode=image-to-video+res=1080p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     35000000, 175000, 1),
    ('veo:veo3_lite:mode=image-to-video+res=4K', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     150000000, 750000, 1),
    ('veo:veo3_lite:mode=image-to-video+res=720p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     30000000, 150000, 1),
    ('veo:veo3_lite:mode=reference-to-video+res=1080p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     35000000, 175000, 1),
    ('veo:veo3_lite:mode=reference-to-video+res=4K', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     150000000, 750000, 1),
    ('veo:veo3_lite:mode=reference-to-video+res=720p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     30000000, 150000, 1),
    ('veo:veo3_lite:mode=text-to-video+res=1080p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     35000000, 175000, 1),
    ('veo:veo3_lite:mode=text-to-video+res=4K', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     150000000, 750000, 1),
    ('veo:veo3_lite:mode=text-to-video+res=720p', 'veo3_lite', 'video.generate', 'veo',
     '/api/v1/veo/generate', '/api/v1/veo/record-info',
     30000000, 150000, 1)
) as seed (
  pricing_key,
  model_id,
  action,
  family,
  create_path,
  poll_path,
  customer_microcredits_per_unit,
  provider_cost_currency_micros_per_unit,
  maximum_units
)
where not exists (select 1 from billing_private.generation_price_catalog);

do $$
declare
  v_rows bigint;
  v_bad bigint;
begin
  select count(*) into v_rows
  from billing_private.generation_price_catalog
  where pricing_version = 'generation-2026-08-06-manifest-v1';
  if v_rows <> 130 then
    raise exception 'Expected 130 seeded generation prices, found %', v_rows;
  end if;

  select count(*) into v_rows from billing_private.generation_price_catalog;
  if v_rows <> 130 then
    raise exception 'generation_price_catalog holds % rows, expected 130', v_rows;
  end if;

  -- Nothing here may charge anyone.
  select count(*) into v_bad from billing_private.generation_price_catalog where active;
  if v_bad <> 0 then
    raise exception '% seeded generation prices are active; the seed must be inert', v_bad;
  end if;

  -- A key stored with stray whitespace is permanently unreachable, because
  -- easyfield_generation_prepare matches btrim(p_pricing_key) against the
  -- stored value untrimmed. A model_id with stray whitespace silently defeats
  -- plan_catalog.blocked_model_ids, which is compared as btrim(p_model_id).
  select count(*) into v_bad
  from billing_private.generation_price_catalog
  where pricing_key <> btrim(pricing_key)
     or model_id <> btrim(model_id)
     or action <> btrim(action);
  if v_bad <> 0 then
    raise exception '% seeded generation prices carry untrimmed identifiers', v_bad;
  end if;

  -- Nothing in the DDL ties family to its routes. A mis-seeded poll_path is
  -- unrecoverable: easyfield_generation_authorize_poll matches on
  -- (user_id, provider_task_ref_sha256, poll_path) and raises 23503
  -- indistinguishably from "not found", so the job is quoted, reserved,
  -- submitted upstream and can never be settled -- it just sits until
  -- expire_credit_reservations releases the reservation 24 hours later.
  -- These six triples are the whole of CREATE_ROUTES/POLL_ROUTES in
  -- supabase/functions/_shared/generation_gateway.ts.
  select count(*) into v_bad
  from billing_private.generation_price_catalog
  where (family, create_path, poll_path) not in (
    ('jobs',   '/api/v1/jobs/createTask',  '/api/v1/jobs/recordInfo'),
    ('veo',    '/api/v1/veo/generate',     '/api/v1/veo/record-info'),
    ('runway', '/api/v1/runway/generate',  '/api/v1/runway/record-detail'),
    ('aleph',  '/api/v1/aleph/generate',   '/api/v1/aleph/record-info'),
    ('suno',   '/api/v1/generate',         '/api/v1/generate/record-info'),
    ('sounds', '/api/v1/generate/sounds',  '/api/v1/generate/record-info')
  );
  if v_bad <> 0 then
    raise exception '% seeded generation prices carry an unroutable family/path triple', v_bad;
  end if;

  -- The documented price rule, restated as an arithmetic invariant:
  -- one EasyField credit is one provider credit, and one provider credit is
  -- 5000 micro-USD, so 1e6 microcredits always accompany 5000 micro-USD.
  select count(*) into v_bad
  from billing_private.generation_price_catalog
  where customer_microcredits_per_unit <> provider_cost_currency_micros_per_unit * 200
     or provider_cost_currency_micros_per_unit <= 0
     or provider_cost_currency_code <> 'USD';
  if v_bad <> 0 then
    raise exception '% seeded generation prices do not restate the documented credit rule', v_bad;
  end if;
end $$;

-- Defence in depth behind the trigger. Nothing in supabase/functions writes to
-- this table, and easyfield_generation_prepare is security definer, so removing
-- the service_role write grants costs nothing and closes the hole that made a
-- silent price rewrite possible in the first place. Seeding and activation are
-- migrations, which run as the owner.
revoke insert, update, delete on table billing_private.generation_price_catalog from service_role;

comment on trigger generation_price_catalog_is_immutable
  on billing_private.generation_price_catalog is
  'Generation prices are append-only. Revise one the way 202607290002 revised a plan: lock the table, prove no non-terminal generation_gateway_jobs row references the pricing_key, disable this trigger, update exactly one row, re-enable it.';

-- Deliberately NOT seeded. A partial catalog that is honest beats a complete
-- one that guesses, and every omission below is a question for a person, not a
-- gap to be filled in by inference:
--
--  * Seedream 5 Pro (all variants) -- its real price is
--    output_rate + max(0, reference_images - 1) * 0.5 per image. One
--    customer_microcredits_per_unit multiplied by one quantity_units cannot
--    express two rates. It is the default model of Angles and Storyboard, so
--    those two tools stay dark until the schema grows a second price axis or
--    their defaults change.
--  * Topaz Image Upscale -- billed by the RESULTING 2K/4K/8K tier, which is not
--    knowable before the provider inspects the source dimensions. A
--    reserve-before-submit gateway needs either a ceiling-and-capture design or
--    an exclusion; guessing a tier would charge the wrong amount.
--  * Grok Imagine Video and Grok Imagine 1.5 Preview -- the reviewed 2026-07-11
--    fallback says 1.6/3.0 credits per second at 480p/720p and the live feed
--    says 2.4/4.5, exactly 1.5x, for both models. Two sources disagree about a
--    current price; seeding either would pick a winner.
--  * Seedance 2 Mini with a video input -- the reviewed fallback carries
--    9.5/20.5 there, which is the NO-video rate; the feed says 6/12.5. Same
--    problem, and it also means the client currently over-quotes that path.
--  * Wan 2.7 Video Edit and HappyHorse Video Edit -- priced per second with a
--    "Full source length" option and no published duration ceiling, so
--    maximum_units (and therefore the size of the credit reservation) would
--    have to be invented.
--  * Topaz Video Upscale -- per second over an arbitrary uploaded clip. Same
--    missing ceiling.
--  * Kling 3 Motion Control -- duration comes from the driver clip; the shipped
--    config publishes no duration list at all.
--  * The entire Avatar family (Kling Avatar Pro/Standard, OmniHuman 1.5,
--    InfiniteTalk, Wan 2.2 A14B Speech-to-Video Turbo, Volcengine Lip Sync) --
--    per second over uploaded audio with no published ceiling, and on top of
--    that the two Kling rows are an unresolved identity question: EasyField
--    submits kling/ai-avatar-pro and kling/ai-avatar-standard while the feed
--    rows that carry those prices identify themselves as v1 models. The numbers
--    match the reviewed fallback exactly, but which endpoint is being priced is
--    not settled, and that is a person's call.
--  * omnihuman-1-5/subject-detection -- a real billable provider call issued
--    before every multi-person OmniHuman run, with no row in the feed and no
--    entry in the reviewed table. It is unpriced today too.
--  * All twelve chat/agent models -- they post to /provider/.../v1/messages,
--    /v1/chat/completions and /v1/responses, none of which is a gateway route
--    at all, so they are out of scope for a price catalog until the gateway
--    learns to carry them. Animations is chat-only and stays dark; Storyboard's
--    script-to-shots planning step and SuperBrain ride the same transport.

commit;
