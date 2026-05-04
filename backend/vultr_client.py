import os
import httpx
from typing import Optional, List, Dict

VULTR_API_KEY = os.environ.get("VULTR_API_KEY", "")
BASE_URL = "https://api.vultr.com/v2"
MAIN_SERVER_URL = os.environ.get("MAIN_SERVER_URL", "http://localhost:8088")
WORKER_API_TOKEN = os.environ.get("WORKER_API_TOKEN", "worker-secret")
ARB_ETH_URL = os.environ.get("ARB_ETH_URL", "https://arb1.arbitrum.io/rpc")

class VultrAPIError(Exception):
    """Raised when Vultr API returns an error."""
    pass

class VultrClient:
    def __init__(self):
        self.api_key = VULTR_API_KEY
        self.headers = {"Authorization": f"Bearer {self.api_key}"}

    async def _request(self, method: str, url: str, json=None):
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, url, headers=self.headers, json=json)
            if resp.status_code == 429:
                detail = resp.json().get("error", "Rate limited") if resp.headers.get("content-type","").startswith("application/json") else "Rate limited"
                raise VultrAPIError(f"Vultr API rate limited (429): {detail}")
            if resp.status_code >= 400:
                detail = resp.json().get("error", resp.text) if resp.headers.get("content-type","").startswith("application/json") else resp.text
                raise VultrAPIError(f"Vultr API error ({resp.status_code}): {detail}")
            return resp.json()

    async def list_regions(self) -> List[Dict]:
        data = await self._request("GET", f"{BASE_URL}/regions")
        return data.get("regions", [])

    async def list_instances(self) -> List[Dict]:
        data = await self._request("GET", f"{BASE_URL}/instances")
        return data.get("instances", [])

    async def create_instance(
        self,
        region: str,
        label: str,
        instance_id: str,
        plan: str = "vc2-1c-1gb",
        s3_keystore_url: str = "",
        s3_password_url: str = ""
    ) -> Dict:
        payload = {
            "region": region,
            "plan": plan,
            "label": label,
            "os_id": 1743,  # Ubuntu 22.04
            "user_data": self._cloud_init(region, instance_id, s3_keystore_url, s3_password_url),
        }
        data = await self._request("POST", f"{BASE_URL}/instances", json=payload)
        return data.get("instance", {})

    async def delete_instance(self, instance_id: str):
        await self._request("DELETE", f"{BASE_URL}/instances/{instance_id}")

    def _cloud_init(
        self,
        region: str,
        instance_id: str,
        s3_keystore_url: str = "",
        s3_password_url: str = ""
    ) -> str:
        script_path = os.path.join(os.path.dirname(__file__), "startup.sh")
        with open(script_path, "r") as f:
            script = f.read()

        script = script.replace("{{MAIN_SERVER_URL}}", MAIN_SERVER_URL)
        script = script.replace("{{WORKER_API_TOKEN}}", WORKER_API_TOKEN)
        script = script.replace("{{WORKER_REGION}}", region)
        script = script.replace("{{VULTR_INSTANCE_ID}}", instance_id)
        script = script.replace("{{RUN_DURATION}}", "300")
        script = script.replace("{{ARB_ETH_URL}}", ARB_ETH_URL)
        script = script.replace("{{S3_KEYSTORE_URL}}", s3_keystore_url)
        script = script.replace("{{S3_PASSWORD_URL}}", s3_password_url)
        script = script.replace("${MAX_CYCLES}", "10")

        return script

vultr = VultrClient()
