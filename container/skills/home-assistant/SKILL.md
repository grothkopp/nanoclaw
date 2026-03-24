# Home Assistant

Home Assistant runs on the local network. Use the REST API via curl/Bash. Authentication is handled automatically by the credential proxy via the `$HA_URL` environment variable.

## REST API

```bash
# Get a specific entity state
curl -s $HA_URL/api/states/sensor.model_y_battery_level

# List all entities (large response — pipe through jq to filter)
curl -s $HA_URL/api/states | jq '.[].entity_id'

# Find entities by keyword
curl -s $HA_URL/api/states | jq -r '.[].entity_id' | grep -i tesla

# Call a service (e.g., turn on a light)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  $HA_URL/api/services/light/turn_on
```

## Key Use Cases

- **Electric cars** — charge level, charging status, range for the Tesla (Model Y) and Cupra (Tavascan)
  - Tesla: `sensor.model_y_battery_level` (%), `sensor.model_y_battery_range` (km)
  - Cupra: `sensor.cupra_tavascan_state_of_charge` (%), `sensor.cupra_tavascan_range_in_kilometers` (km)
- **Solar PV system** — current solar production, battery charge level, consumption
  - `sensor.soc_battery` — home battery state of charge (%)
  - `sensor.power_solar` — current solar production (W)
  - `sensor.power_consumption` — current household consumption (W)
- **Weather** — local weather conditions, forecasts, temperature, wind, rain
- **Lights** — turn on/off, set brightness

## Tips

- Entity IDs follow `domain.name` pattern (e.g., `sensor.model_y_battery_level`, `light.kitchen`)
- If unsure about entity names, search with `grep -i` on the full entity list
- The state response includes `state` (the value) and `attributes` (unit, friendly name, etc.)
- When reporting car or PV status, include the key numbers (percentage, kW, range)
