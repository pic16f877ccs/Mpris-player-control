export const MPRIS_IFACE_PATH = "org.mpris.MediaPlayer2"; 
export const MPRIS_OBJECT_PATH = "/org/mpris/MediaPlayer2"; 
export const MPRIS_PLAYER_IFACE_XML = `
<node>
    <interface name="org.mpris.MediaPlayer2.Player">
        <method name="PlayPause"/>
        <method name="Next"/>
        <method name="Previous"/>
        <method name="Stop"/>
        <method name="Seek">
            <arg type="x" direction="in" name="Offset"/>
        </method>
        <method name="SetPosition">
            <arg type="o" direction="in" name="TrackId"/>
            <arg type="x" direction="in" name="Position"/>
        </method>
        <property name="CanGoNext" type="b" access="read"/>
        <property name="CanGoPrevious" type="b" access="read"/>
        <property name="CanPlay" type="b" access="read"/>
        <property name="CanSeek" type="b" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/>
        <property name="PlaybackStatus" type="s" access="read"/>
        <property name="Position" type="x" access="read"/>
        <signal name="Seeked">
            <arg type="x" direction="out" name="position"/>
        </signal>
    </interface>
</node>`;

export const FREEDESKTOP_DBUS_INDEX = 0;
export const FREEDESKTOP_DBUS_IFACE_PATH = "org.freedesktop.DBus";
export const FREEDESKTOP_DBUS_OBJECT_PATH = "/org/freedesktop/DBus";
export const FREEDESKTOP_DBUS_IFACE_XML = `
<node>
    <interface name="org.freedesktop.DBus">
        <method name="ListNames">
            <arg type="as" direction="out" name="names"/>
        </method>
        <method name="GetConnectionUnixProcessID">
            <arg type="s" direction="in"/>
            <arg type="u" direction="out"/>
        </method>
        <signal name="NameOwnerChanged">
            <arg type="s" direction="out" name="name"/>
            <arg type="s" direction="out" name="oldOwner"/>
            <arg type="s" direction="out" name="newOwner"/>
        </signal>
    </interface>
</node>`;

export const MPRIS_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="Identity" type="s" access="read"/>
  </interface>
</node>`;

//export const FREEDESKTOP_DBUS_PROPERTIES_IFACE_PATH = "org.freedesktop.DBus.Properties";
//export const FREEDESKTOP_DBUS_PROPERTIES_OBJECT_PATH = "/org/freedesktop/DBus.Properties";
export const FREEDESKTOP_DBUS_PROPERTIES_IFACE_XML = `
<node>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg type="s" name="interfaceName" direction="in"/>
      <arg type="s" name="propertyName" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="GetAll">
      <arg type="s" name="interfaceName" direction="in"/>
      <arg type="a{sv}" name="properties" direction="out"/>
    </method>
    <method name="Set">
      <arg type="s" name="interfaceName" direction="in"/>
      <arg type="s" name="propertyName" direction="in"/>
      <arg type="v" name="value" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg type="s" name="interfaceName"/>
      <arg type="a{sv}" name="changedProperties"/>
      <arg type="as" name="invalidatedProperties"/>
    </signal>
  </interface>
</node>`;

export const TRIPLE_CONTROL_KEYS = ['Stopped', 'Playing', 'Paused'];
export const CONTROL_KEYS_LAYOUT = {
    'minimal': ['Stopped'],
    'basic': ['Stopped', 'Forward'],
    'standard': ['Backward', 'Stopped', 'Forward'],
    'full': ['Backward', 'Playing', 'Stopped', 'Forward'],
};
