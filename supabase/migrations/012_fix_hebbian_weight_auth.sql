-- 012_fix_hebbian_weight_auth.sql
-- Fix update_hebbian_weight: add NOT FOUND check, prevent silent failures

CREATE OR REPLACE FUNCTION update_hebbian_weight(
  assoc_id uuid,
  reinforcement float,
  learning_rate float DEFAULT 0.1,
  decay_rate float DEFAULT 0.01
)
RETURNS float
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  current_weight float;
  new_weight float;
  time_decay float;
  hours_since_activation float;
BEGIN
  SELECT weight, extract(epoch FROM (now() - last_activated_at)) / 3600
  INTO current_weight, hours_since_activation
  FROM hebbian_associations
  WHERE id = assoc_id;

  -- Fail explicitly if association not found
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hebbian association not found: %', assoc_id;
  END IF;

  -- Apply time-based decay
  time_decay = exp(-decay_rate * hours_since_activation);
  current_weight = current_weight * time_decay;

  -- Apply Hebbian update rule: w_new = w_old + lr * (reinforcement - w_old)
  new_weight = current_weight + learning_rate * (reinforcement - current_weight);

  -- Clamp to valid range
  new_weight = greatest(0, least(1, new_weight));

  -- Update the association
  UPDATE hebbian_associations
  SET weight = new_weight,
      activation_count = activation_count + 1,
      last_activated_at = now()
  WHERE id = assoc_id;

  RETURN new_weight;
END;
$$;
