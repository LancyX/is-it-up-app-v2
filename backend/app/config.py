from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ha_base_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""
    grid_entity_id: str = "binary_sensor.grid_power"
    # Optional DTEK outage schedule: region (kyiv-region, kyiv, dnipro, odesa) and queue (e.g. 5.1);
    # either empty = no schedule
    schedule_region: str = ""
    schedule_queue: str = ""
    # DTEK's schedule (outage-data-ua JSON); empty = derived from the region
    schedule_dtek_url: str = ""
    # DTEK proxy behind svitlo.live, only for the region's emergency outages flag; empty = never shown
    schedule_emergency_api_url: str = "https://dtek-api.svitlo-proxy.workers.dev/"
    # Optional DTEK Monitor (HACS, groove-max/ha-dtek-monitor) "outage status" sensor for your address
    # (sensor.dtek_krem_<id>_outage_status); its sibling sensors are derived from it. Empty = not shown
    address_entity_id: str = ""
    # Where past schedules are recorded (schedule.json)
    data_dir: str = "data"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    model_config = {"env_prefix": ""}


settings = Settings()
