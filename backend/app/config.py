from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ha_base_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""
    grid_entity_id: str = "binary_sensor.grid_power"
    # Optional svitlo.live status sensor (sensor.svitlo_<region>_<queue>_electricity); empty = no schedule
    schedule_entity_id: str = ""
    # Its calendar entity; empty = derived from schedule_entity_id (calendar.svitlo_<region>_<queue>_outages_schedule)
    schedule_calendar_id: str = ""
    # svitlo.live API, used directly for days the HA integration doesn't have (it can lag); empty = HA only
    schedule_api_url: str = "https://svitlo-proxy.svitlo-proxy.workers.dev"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    model_config = {"env_prefix": ""}


settings = Settings()
