#!/usr/bin/env bash
set -euo pipefail

# Only loopback traffic to/from the measured DS port enters netem. Platform stays
# in the untouched default band. This script is for a disposable hosted runner.
action=${1:?action}
port=${2:?DS port}
[[ $port =~ ^[0-9]+$ ]] && (( port > 0 && port < 65536 ))
case "$action" in
  apply)
    delay=${3:?delay}; jitter=${4:?jitter}; loss=${5:?loss}
    [[ $delay =~ ^[0-9]+$ && $jitter =~ ^[0-9]+$ && $loss =~ ^[0-9]+$ ]]
    current=$(tc qdisc show dev lo)
    [[ $current == 'qdisc noqueue '* ]] || { echo "Refusing to replace existing lo qdisc: $current" >&2; exit 1; }
    # Ubuntu 24.04's iproute2 can lack netem's newer seed option. Preserve the
    # requested impairment and record whether its random sequence is repeatable.
    seed_args=()
    netem_help=$(tc qdisc add dev lo root netem help 2>&1 || true)
    if [[ $netem_help == *seed* ]]; then
      seed_args=(seed 270927)
      echo 'netem random seed: 270927'
    else
      echo 'netem random seed: kernel-selected (tc does not support seed)'
    fi
    tc qdisc add dev lo root handle 917: prio bands 3 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    tc qdisc add dev lo parent 917:3 handle 918: netem limit 100000 delay "${delay}ms" "${jitter}ms" loss random "${loss}%" "${seed_args[@]}"
    tc filter add dev lo parent 917: protocol ip prio 1 u32 match ip protocol 6 0xff match ip dport "$port" 0xffff flowid 917:3
    tc filter add dev lo parent 917: protocol ip prio 2 u32 match ip protocol 6 0xff match ip sport "$port" 0xffff flowid 917:3
    ;;
  remove)
    current=$(tc qdisc show dev lo)
    if [[ $current == *'qdisc prio 917:'* ]]; then tc qdisc del dev lo root handle 917:; fi
    ;;
  drop|restore)
    shift 2
    (( $# == 10 )) || { echo 'Exactly ten client ports are required.' >&2; exit 1; }
    for client_port in "$@"; do
      [[ $client_port =~ ^[0-9]+$ ]] && (( client_port > 0 && client_port < 65536 ))
    done
    operation=-A; [[ $action == restore ]] && operation=-D
    # OUTPUT sees each loopback direction once. Both exact tuples are dropped,
    # including retransmissions/ACKs; a reconnect with a new tuple is not faked.
    # One COMMIT changes all ten tuples together. --noflush preserves Docker and runner rules.
    {
      echo '*filter'
      for client_port in "$@"; do
        echo "$operation OUTPUT -o lo -p tcp -s 127.0.0.1 -d 127.0.0.1 --sport $client_port --dport $port -m comment --comment lumio-weaknet -j DROP"
        echo "$operation OUTPUT -o lo -p tcp -s 127.0.0.1 -d 127.0.0.1 --sport $port --dport $client_port -m comment --comment lumio-weaknet -j DROP"
      done
      echo COMMIT
    } | iptables-restore --noflush
    ;;
  inspect)
    tc -s qdisc show dev lo
    tc -s filter show dev lo parent 917:
    iptables -L OUTPUT -n -v
    ;;
  counters) iptables-save -c -t filter ;;
  *) echo "Unknown action: $action" >&2; exit 1;;
esac
