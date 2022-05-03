"""Test the ImJoy RPC module."""
WS_PORT = 38283
WS_SERVER_URL = f"http://127.0.0.1:{WS_PORT}"


def find_item(items, key, value):
    """Find an item with key or attributes in an object list."""
    filtered = [
        item
        for item in items
        if (item[key] if isinstance(item, dict) else getattr(item, key)) == value
    ]
    if len(filtered) == 0:
        return None

    return filtered[0]
