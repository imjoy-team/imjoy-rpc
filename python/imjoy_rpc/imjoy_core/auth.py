import json
import time
import ssl
import uuid
import traceback
from os import environ as env
from typing import Optional, List
import logging
import sys

from dotenv import find_dotenv, load_dotenv
from fastapi import Header, HTTPException, Request
from jose import jwt
from pydantic import BaseModel
from urllib.request import urlopen

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("imjoy-core")
logger.setLevel(logging.INFO)

ENV_FILE = find_dotenv()
if ENV_FILE:
    load_dotenv(ENV_FILE)

AUTH0_DOMAIN = env.get("AUTH0_DOMAIN", "imjoy.eu.auth0.com")
AUTH0_AUDIENCE = env.get("AUTH0_AUDIENCE", "https://imjoy.eu.auth0.com/api/v2/")
JWT_SECRET = env.get("JWT_SECRET")
if not JWT_SECRET:
    logger.warning("JWT_SECRET is not defined")
    JWT_SECRET = str(uuid.uuid4())


class AuthError(Exception):
    def __init__(self, error, status_code):
        self.error = error
        self.status_code = status_code


class ValidToken(BaseModel):
    credentials: dict
    scopes: List[str] = []

    def hasScope(self, checkedToken):
        if checkedToken in self.scopes:
            return True
        else:
            raise HTTPException(
                status_code=403, detail="Not authorised to perform this action"
            )


def login_required(request: Request, authorization: str = Header(None)):
    return valid_token(authorization, request)


def admin_required(request: Request, authorization: str = Header(None)):
    token = valid_token(authorization, request)
    roles = token.credentials.get("https://api.imjoy.io/roles", [])
    if "admin" not in roles:
        raise HTTPException(status_code=401, detail="Admin required")
    return token


def is_admin(token):
    roles = token.credentials.get("https://api.imjoy.io/roles", [])
    if "admin" not in roles:
        return False
    return True


def get_user_email(token):
    return token.credentials.get("https://api.imjoy.io/email")


def get_user_id(token):
    return token.credentials.get("sub")


def get_user_info(token):
    return {
        "user_id": token.credentials.get("sub"),
        "email": token.credentials.get("https://api.imjoy.io/email"),
        "roles": token.credentials.get("https://api.imjoy.io/roles", []),
    }


jwks = None


def get_rsa_key(kid, refresh=False):
    global jwks
    if jwks is None or refresh:
        jsonurl = urlopen(
            f"https://{AUTH0_DOMAIN}/.well-known/jwks.json",
            context=ssl._create_unverified_context(),
        )
        jwks = json.loads(jsonurl.read())
    rsa_key = {}
    for key in jwks["keys"]:
        if key["kid"] == kid:
            rsa_key = {
                "kty": key["kty"],
                "kid": key["kid"],
                "use": key["use"],
                "n": key["n"],
                "e": key["e"],
            }
            break
    return rsa_key


def simulate_user_token(returnedToken, request):
    """
    Allow admin users to simulate another user
    """
    if "user_id" in request.query_params:
        returnedToken.credentials["sub"] = request.query_params["user_id"]
    if "email" in request.query_params:
        returnedToken.credentials["https://api.imjoy.io/email"] = request.query_params[
            "email"
        ]
    if "roles" in request.query_params:
        returnedToken.credentials["https://api.imjoy.io/roles"] = request.query_params[
            "roles"
        ].split(",")


def valid_token(authorization: str, request: Optional[Request] = None):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is expected")

    parts = authorization.split()

    if parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401, detail="Authorization header must start with" " Bearer"
        )
    elif len(parts) == 1:
        raise HTTPException(status_code=401, detail="Token not found")
    elif len(parts) > 2:
        raise HTTPException(
            status_code=401, detail="Authorization header must be 'Bearer' token"
        )

    authorization = parts[1]
    try:
        unverified_header = jwt.get_unverified_header(authorization)
        unverified_claims = jwt.get_unverified_claims(authorization)

        # Get RSA key
        rsa_key = get_rsa_key(unverified_header["kid"], refresh=False)
        # Try to refresh jwks if failed
        if not rsa_key:
            rsa_key = get_rsa_key(unverified_header["kid"], refresh=True)

        # Decode token
        payload = jwt.decode(
            authorization,
            rsa_key,
            algorithms=["RS256"],
            audience=AUTH0_AUDIENCE,
            issuer=f"https://{AUTH0_DOMAIN}/",
        )

        returnedToken = ValidToken(
            credentials=payload, scopes=payload["scope"].split(" ")
        )

        # This is needed for patching the test token
        if "create:roles" in payload["scope"]:
            if "https://api.imjoy.io/roles" not in returnedToken.credentials:
                returnedToken.credentials["https://api.imjoy.io/roles"] = ["admin"]
            if "https://api.imjoy.io/email" not in returnedToken.credentials:
                returnedToken.credentials["https://api.imjoy.io/email"] = None

        if (
            "admin" in returnedToken.credentials["https://api.imjoy.io/roles"]
            and request
        ):
            simulate_user_token(returnedToken, request)

        return returnedToken

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401, detail="The token has expired. Please fetch a new one"
        )
    except jwt.JWTError:
        raise HTTPException(status_code=401, detail=traceback.format_exc())


def generate_presigned_token(user_info, config):
    """generating presigned tokens.
    This will generate a token which will be connected as a child user
    Child user may generate more child user token if it has admin permission
    """
    scope = config.get("scope")
    if scope and user_info.scopes and scope not in user_info.scopes:
        return {
            "success": False,
            "detail": f"User have no permission to scope: {scope}",
        }
    # always generate a new user id
    uid = str(uuid.uuid4())
    expires_in = config.get("expires_in")
    if expires_in:
        expires_at = time.time() + expires_in
    else:
        expires_at = None
    token = jwt.encode(
        {
            "scopes": [scope] if scope else None,
            "expires_at": expires_at,
            "user_id": uid,
            "parent": user_info.parent if user_info.parent else user_info.id,
            "email": None,
            "roles": [],
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    return {"success": True, "result": "#RTC:" + token}
