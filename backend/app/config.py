from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ha_base_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""
    grid_entity_id: str = "binary_sensor.grid_power"
    # Optional svitlo.live status sensor (sensor.svitlo_<region>_<queue>_electricity); empty = no schedule
    schedule_entity_id: str = ""
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    model_config = {"env_prefix": ""}


settings = Settings()
