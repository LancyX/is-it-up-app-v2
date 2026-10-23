from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ha_base_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""
    grid_entity_id: str = "binary_sensor.grid_power"
    # Optional outage schedule from svitlo.live: region id as in its API (e.g. kiivska-oblast) and
    # queue (e.g. 5.1); either empty = no schedule
    schedule_region: str = ""
    schedule_queue: str = ""
    schedule_api_url: str = "https://svitlo-proxy.svitlo-proxy.workers.dev"
    # DTEK proxy, only for its emergency outages flag; empty = never shown
    schedule_emergency_api_url: str = "https://dtek-api.svitlo-proxy.workers.dev/"
    # Where past schedules are recorded (schedule.json)
    data_dir: str = "data"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    model_config = {"env_prefix": ""}


settings = Settings()
